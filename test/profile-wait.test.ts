import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ExplorerRow, ProfileBusy, profileBusyOf } from "../src/browser/browsers.js";
import {
  PROFILE_BUSY_STATUS,
  takeable,
  takeIdleExplore,
  waitForProfile,
} from "../src/browser/profile-wait.js";

/** A stand-in Context: each step runs once, each sleep is noted and returns at once. */
function ctxOf() {
  const steps: string[] = [];
  const slept: number[] = [];
  const ctx = {
    run: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      steps.push(name);
      return fn();
    },
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  } as never;
  return { ctx, steps, slept };
}

const busyBy = (opener: string) => new ProfileBusy("google@test", 4242, opener, "");

/** `fn` that finds the profile busy `n` times, then answers `ok`. */
function busyThen(n: number, opener = "cli") {
  const tries = { n: 0 };
  const fn = async () => {
    if (tries.n++ < n) throw busyBy(opener);
    return "ok";
  };
  return { fn, tries };
}

const row = (o: Partial<ExplorerRow>): ExplorerRow =>
  ({
    port: 9092,
    pid: process.pid,
    driver: "agent",
    held: false,
    idleMs: 0,
    idleMinutes: 0,
    ...o,
  }) as ExplorerRow;

describe("profileBusyOf", () => {
  it("finds the busy profile by class, through a cause, or by its words over the wire", () => {
    const b = busyBy("explore:9092");
    expect(profileBusyOf(b)).toBe(b);
    expect(profileBusyOf(new Error("wrapped", { cause: b }))).toBe(b);
    const said = profileBusyOf(
      new Error(
        "tiktok POST /web/posts: 500 profile google@test is open in pid 11913 (explore:9092)",
      ),
    );
    expect(said).toMatchObject({ profile: "google@test", pid: 11913, opener: "explore:9092" });
    expect(profileBusyOf(new Error("socket hang up"))).toBeNull();
  });
});

describe("waitForProfile", () => {
  it("runs at once when the profile is free", async () => {
    const { ctx, steps, slept } = ctxOf();
    expect(await waitForProfile(ctx, "post", async () => 1)).toBe(1);
    expect(steps).toEqual(["post"]);
    expect(slept).toEqual([]);
  });

  it("waits out a busy profile with durable sleeps, then runs once", async () => {
    const { ctx, steps, slept } = ctxOf();
    const { fn, tries } = busyThen(4);
    expect(await waitForProfile(ctx, "post", fn)).toBe("ok");
    expect(tries.n).toBe(5);
    expect(steps).toEqual(["post", "post (try 2)", "post (try 3)", "post (try 4)", "post (try 5)"]);
    // 15 s, 30 s, then a minute at a time.
    expect(slept).toEqual([15_000, 30_000, 60_000, 60_000]);
  });

  it("past its bound goes back as not sent, under the busy status", async () => {
    const { ctx, slept } = ctxOf();
    const { fn } = busyThen(1_000, "explore:9092");
    const err = await waitForProfile(ctx, "post", fn, { wait: { boundMs: 2 * 60_000 } }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({
      name: "TerminalError",
      code: PROFILE_BUSY_STATUS,
      message:
        "not sent: profile google@test is busy (explore:9092); waited 3 min for it, try again",
    });
    // 15 + 30 + 60 + 60 s: the first look past two minutes gives up.
    expect(slept).toEqual([15_000, 30_000, 60_000, 60_000]);
  });

  it("anything but a busy profile goes on as it is", async () => {
    const { ctx, slept } = ctxOf();
    await expect(
      waitForProfile(ctx, "post", async () => {
        throw new Error("socket hang up");
      }),
    ).rejects.toThrow("socket hang up");
    expect(slept).toEqual([]);
  });

  it("only a write takes an idle explore's profile", async () => {
    const closed: number[] = [];
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-take-"));
    const info = join(dir, "explore-9092.json");
    writeFileSync(info, JSON.stringify(row({})));
    const old = new Date(Date.now() - 4 * 60_000);
    utimesSync(info, old, old);
    const wait = {
      explorersDir: dir,
      procs: async () => [{ pid: process.pid, ppid: 1, command: "node" }] as never,
      closeExplore: async (port: number) => {
        closed.push(port);
        rmSync(info, { force: true });
      },
    };
    // A read waits.
    const read = busyThen(1, "explore:9092");
    expect(await waitForProfile(ctxOf().ctx, "read", read.fn, { wait })).toBe("ok");
    expect(closed).toEqual([]);
    // A write takes it, then runs in the same step: no sleep.
    const write = busyThen(1, "explore:9092");
    const c = ctxOf();
    expect(await waitForProfile(c.ctx, "post", write.fn, { take: true, wait })).toBe("ok");
    expect(closed).toEqual([9092]);
    expect(c.slept).toEqual([]);
    expect(c.steps).toEqual(["post"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the lease", () => {
  it("a write takes only a session nobody drives or holds, past the idle mark", () => {
    const mark = 3 * 60_000;
    expect(takeable(row({ idleMs: mark }), mark)).toBe(true);
    expect(takeable(row({ idleMs: mark - 1 }), mark)).toBe(false);
    expect(takeable(row({ idleMs: mark, held: true }), mark)).toBe(false);
    expect(takeable(row({ idleMs: mark, driver: "person" }), mark)).toBe(false);
  });

  it("never takes from a desk, a CLI run or a teach session", async () => {
    const closeExplore = async () => {
      throw new Error("must not close");
    };
    for (const opener of ["desk", "cli", "teach:9120"])
      expect(await takeIdleExplore(busyBy(opener), { closeExplore })).toBe(false);
  });

  it("an active session keeps its profile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-take-"));
    writeFileSync(join(dir, "explore-9092.json"), JSON.stringify(row({})));
    let closed = false;
    const took = await takeIdleExplore(busyBy("explore:9092"), {
      explorersDir: dir,
      procs: async () => [{ pid: process.pid, ppid: 1, command: "node" }] as never,
      closeExplore: async () => {
        closed = true;
      },
    });
    expect(took).toBe(false);
    expect(closed).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
