/**
 * A busy Chrome profile queues a call, never fails it (designs/2026-10-15-profile-wait.md).
 *
 * A profile opens in one browser at a time (`assertProfileFree`). When another process holds
 * it (an explore session, a CLI run), nothing was opened and nothing was done: the call waits
 * for the profile with Restate's durable sleep, then runs once. Past the bound it goes back to
 * the caller as `not sent: …` under `PROFILE_BUSY_STATUS`, which a scheduler reads as "try
 * again next tick", never as a failed post.
 *
 * A write may take the profile from an explore session nobody is driving: past
 * `TAKE_IDLE_MINUTES` with no command it is closed (journal kept, so the next session resumes
 * on its page) and the write runs. A session someone drives, or a held one, keeps it.
 */
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunOptions } from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk";
import { TAKE_IDLE_MINUTES } from "../explore/lease.js";
import {
  type ExplorerRow,
  lockHolder,
  type ProfileBusy,
  profileBusyOf,
  readExplorers,
} from "./browsers.js";
import { listProcs, type Proc } from "./reap.js";

/** The status a call that waited out its bound goes back under: nothing sent, ask again. */
export const PROFILE_BUSY_STATUS = 503;

/** How a failure that never reached the page starts: nothing left this machine. */
export const NOT_SENT = "not sent: ";

/** Said after a failure whose submit step had started: it may be live. */
export const MAY_HAVE_GONE_THROUGH = "may have gone through";

export interface ProfileWait {
  /** How long a call waits for a busy profile before it goes back (default 5 min). */
  boundMs?: number;
  /** Pauses between looks, durable; the last one repeats (default 15 s, 30 s, then 60 s). */
  pausesMs?: readonly number[];
  /** An explore session idle this long gives its profile to a write (default `TAKE_IDLE_MINUTES`). */
  takeIdleMs?: number;
  /** Where explore sessions leave their info and token files (default `$TMPDIR/autobrowse`). */
  explorersDir?: string;
  /** Every process, for who serves an explore port; tests pass their own. */
  procs?: () => Promise<Proc[]>;
  /** Close an explore session, journal kept; default: its `close` command over loopback. */
  closeExplore?: (port: number, why: string) => Promise<void>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export const PROFILE_WAIT_DEFAULTS = {
  boundMs: 5 * 60_000,
  pausesMs: [15_000, 30_000, 60_000],
  takeIdleMs: TAKE_IDLE_MINUTES * 60_000,
} as const;

/** What a busy try answers in the journal instead of throwing: a retry would count against the write's one try. */
interface BusyAnswer {
  profileBusy: { profile: string; opener: string; pid: number };
}

const isBusyAnswer = (v: unknown): v is BusyAnswer =>
  typeof v === "object" &&
  v !== null &&
  "profileBusy" in v &&
  Object.keys(v as object).length === 1;

/** An explore session a write may take: nobody drove it for `idleMs`, and nobody holds it on purpose. */
export const takeable = (e: ExplorerRow, idleMs: number): boolean =>
  !e.held && e.driver !== "person" && e.idleMs >= idleMs;

/** The port of an explore or agent session that owns a browser (`explore:9092`), else null. */
const explorePort = (opener: string): number | null => {
  const m = /^(?:explore|agent):(\d+)$/.exec(opener);
  return m ? Number(m[1]) : null;
};

/** `close` over the session's loopback socket, with its bearer token; the journal stays. */
export const closeExploreAt =
  (dir: string) =>
  async (port: number, why: string): Promise<void> => {
    const token = (await readFile(join(dir, `explore-${port}.token`), "utf8")).trim();
    const r = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ cmd: "close", keep: true, why }),
    });
    if (!r.ok) throw new Error(`explore ${port} did not close: ${r.status}`);
  };

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Close the idle explore session holding `busy`'s profile and wait for its browser to let go.
 * True when the profile is free now. Logged either way it acts.
 */
export async function takeIdleExplore(busy: ProfileBusy, o: ProfileWait = {}): Promise<boolean> {
  const port = explorePort(busy.opener);
  if (port === null) return false;
  const dir = o.explorersDir ?? join(tmpdir(), "autobrowse");
  const procs = await (o.procs ?? listProcs)().catch(() => [] as Proc[]);
  const ex = readExplorers(procs, dir).find((e) => e.port === port);
  const idleMs = o.takeIdleMs ?? PROFILE_WAIT_DEFAULTS.takeIdleMs;
  if (!ex || !takeable(ex, idleMs)) return false;
  const idle = Math.floor(ex.idleMs / 60_000);
  const why = `a scheduled write took profile ${busy.profile} after ${idle} min idle`;
  try {
    await (o.closeExplore ?? closeExploreAt(dir))(port, why);
  } catch (err) {
    o.log?.("profile take failed", {
      profile: busy.profile,
      opener: busy.opener,
      error: String(err),
    });
    return false;
  }
  // The browser closes after the socket: wait for its lock (or, without the directory, the session) to go.
  const held = () =>
    busy.profileDir
      ? lockHolder(busy.profileDir) !== null
      : readExplorers(procs, dir).some((e) => e.port === port);
  for (let i = 0; i < 80 && held(); i++) await pause(250);
  o.log?.("profile taken from idle explore", {
    profile: busy.profile,
    opener: busy.opener,
    idleMinutes: idle,
    journal: "kept",
  });
  return !held();
}

/** The parts of a Restate context the wait uses. */
export type WaitContext = Pick<restate.Context, "run" | "sleep">;

/**
 * `fn` as the durable step `step`, waiting out a busy profile: each busy try is journaled as
 * one, then a durable sleep, then another try, until it runs or `boundMs` has passed. `take`:
 * a write, which may close an idle explore session holding the profile first.
 * Everything else `fn` throws goes on as it would from `ctx.run`.
 */
export async function waitForProfile<T>(
  ctx: WaitContext,
  step: string,
  fn: () => Promise<T>,
  o: { retry?: RunOptions<T>; take?: boolean; wait?: ProfileWait } = {},
): Promise<T> {
  const w = { ...PROFILE_WAIT_DEFAULTS, ...o.wait };
  const once = async (): Promise<T | BusyAnswer> => {
    try {
      return await fn();
    } catch (err) {
      let busy = profileBusyOf(err);
      if (!busy) throw err;
      if (o.take && (await takeIdleExplore(busy, w)))
        try {
          return await fn();
        } catch (again) {
          busy = profileBusyOf(again);
          if (!busy) throw again;
        }
      w.log?.("profile busy, waiting", { step, profile: busy.profile, opener: busy.opener });
      return { profileBusy: { profile: busy.profile, opener: busy.opener, pid: busy.pid } };
    }
  };
  let waited = 0;
  for (let n = 1; ; n++) {
    const name = n === 1 ? step : `${step} (try ${n})`;
    const got = (await ctx.run(name, once, o.retry as RunOptions<T | BusyAnswer>)) as
      | T
      | BusyAnswer;
    if (!isBusyAnswer(got)) return got;
    if (waited >= w.boundMs) {
      const { profile, opener } = got.profileBusy;
      const took =
        waited < 60_000 ? `${Math.round(waited / 1000)} s` : `${Math.round(waited / 60_000)} min`;
      throw new restate.TerminalError(
        `${NOT_SENT}profile ${profile} is busy (${opener}); waited ${took} for it, try again`,
        { errorCode: PROFILE_BUSY_STATUS },
      );
    }
    const ms = w.pausesMs[Math.min(n - 1, w.pausesMs.length - 1)] ?? 60_000;
    await ctx.sleep(ms);
    waited += ms;
  }
}
