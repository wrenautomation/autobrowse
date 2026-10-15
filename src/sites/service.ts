/**
 * The site facade as the Restate service `sites`, for an orchestrator on the
 * same Restate (wren): `sites/call` is one official-API call, `sites/status`
 * the routes and setup rows, `sites/setup` one setup step, `sites/renew` every token about to lapse,
 * `sites/caps` a day's capped reads and who made them. The worker dials
 * Restate, so a call queues while the box is down and answers when it is up:
 * no inbound port, no reachability from the caller's side. A `SiteError` is
 * terminal under its own status; a write runs once (an irreversible post is
 * never retried into a duplicate), a read retries like a browser leg.
 * `sites/arm` takes a call and runs its browser leg up to the last safe step, answering an arm
 * id the real call carries (`armId`).
 * With watchers (the desk), `watch` leases a tab watcher, `unwatch` ends one, `watches` lists them.
 * A busy browser profile is waited for, durably, never a failure (`browser/profile-wait`); a
 * write that fails says whether it was sent: `not sent: …` before its submit step, `…; may have
 * gone through` after it.
 */
import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import { type CallTry, withCall } from "../browser/attempt.js";
import { profileBusyOf } from "../browser/browsers.js";
import {
  MAY_HAVE_GONE_THROUGH,
  NOT_SENT,
  type ProfileWait,
  waitForProfile,
} from "../browser/profile-wait.js";
import type { Watchers } from "../browser/watchers.js";
import { HttpError, lastingRefusal } from "../clients/http.js";
import type { SiteCalls } from "../runs/calls.js";
import type { SiteFacade } from "./facade.js";
import { SiteError } from "./types.js";

export const SITES_SERVICE = "sites";
/**
 * The same facade served from the Mac (`src/app/desk.ts`): legs a site
 * refuses from the box's datacenter IP (Reddit) run on a home IP.
 */
export const DESK_SERVICE = "desk";

const READ_RETRY = {
  maxRetryAttempts: 300,
  initialRetryInterval: 1_000,
  retryIntervalFactor: 2,
  maxRetryInterval: 300_000,
};
const WRITE_RETRY = { maxRetryAttempts: 1 };
/**
 * Tries of a read before a platform's 429, 5xx or timeout on the API leg goes back to the
 * caller (wren pauses and asks again a few times): 300 tries a day, each up to three HTTP
 * calls, only pile on a platform that is already saying no. A browser leg keeps waiting.
 */
const API_READ_TRIES = 4;

/** `account`: which identity's token (a consented address); the site's own when absent. */
const site = z.object({ site: z.string().min(1), account: z.string().min(1).optional() });
const call = site.extend({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().startsWith("/"),
  input: z.record(z.string(), z.unknown()).default({}),
  /** Who is asking (`wren:demo`), for the caps ledger; the `x-caller` header says it too. */
  caller: z.string().min(1).max(120).optional(),
  /** An earlier `arm`'s id: the leg runs in its tab, already on the page. */
  armId: z.string().uuid().optional(),
});
const setup = site.extend({ step: z.string().min(1) });

/** A request the shape rejects is the caller's mistake: terminal 400, nothing ran. */
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new restate.TerminalError(r.error.message, { errorCode: 400 });
  return r.data;
}

/**
 * A failed write's words say whether it left: `not sent: …` when its submit step never started,
 * `…; may have gone through` when it did. Words that already say either stay as they are.
 */
export function sentWords(message: string, submitted: boolean): string {
  if (message.startsWith(NOT_SENT) || message.includes(MAY_HAVE_GONE_THROUGH)) return message;
  return submitted ? `${message}; ${MAY_HAVE_GONE_THROUGH}` : `${NOT_SENT}${message}`;
}

/**
 * A SiteError is the caller's to read (404 route, 400 request, 501 no leg, 409 blocked, 502 failed),
 * and so is a platform's lasting refusal; nothing else is.
 * Runs as the durable call `key`: a browser leg's irreversible act (a post) that went
 * through before a crash or a lost connection is not done again when Restate reruns it.
 * A busy profile goes on as it is: `waitForProfile` waits it out.
 * `write`: a write runs once, so whatever ends it is terminal here, its words saying whether
 * it was sent (`sentWords`); a refusal before any page (a SiteError under 500) as it is.
 */
async function terminalOnSiteError<T>(
  key: string,
  fn: () => Promise<T>,
  /** Which try this is, for a read: past `API_READ_TRIES` a platform's HTTP failure is terminal too. */
  attempt?: number,
  write = false,
): Promise<T> {
  const t: CallTry = { key, submitted: false };
  try {
    return await withCall(key, fn, t);
  } catch (err) {
    if (profileBusyOf(err)) throw err;
    if (write && !(err instanceof restate.TerminalError)) {
      const status =
        err instanceof SiteError || lastingRefusal(err) ? (err as SiteError).status : 500;
      const message = err instanceof Error ? err.message : String(err);
      throw new restate.TerminalError(status < 500 ? message : sentWords(message, t.submitted), {
        errorCode: status,
      });
    }
    if (err instanceof SiteError || lastingRefusal(err))
      throw new restate.TerminalError(err.message, { errorCode: err.status });
    if (attempt !== undefined && attempt >= API_READ_TRIES && err instanceof HttpError)
      throw new restate.TerminalError(err.message, {
        errorCode: err.status >= 400 ? err.status : 502,
      });
    throw err;
  }
}

/**
 * A call can be one long step: a video's bytes run for minutes. Restate's default timeouts cut
 * such a step off mid-upload (every ~3 minutes on 10-07) and rerun it, so the bytes never finish.
 */
const CALL_MS = 2 * 60 * 60_000;
const CALL_OPTS = { inactivityTimeout: CALL_MS, abortTimeout: CALL_MS };

/**
 * Each try of `fn` as one ledger line: ok, or the error and whether the caller gets it.
 * Inside `ctx.run`, so a replay (answered from the journal) writes nothing.
 */
async function recorded<T>(
  calls: SiteCalls | undefined,
  base: { service: string; site: string; route: string; caller: string | null; invocation: string },
  attempt: number,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  const at = new Date(t0).toISOString();
  try {
    const out = await fn();
    calls?.record({
      ...base,
      at,
      attempt,
      ok: true,
      status: null,
      terminal: false,
      error: null,
      ms: Date.now() - t0,
    });
    return out;
  } catch (err) {
    const terminal = err instanceof restate.TerminalError;
    const status = terminal ? (err.code ?? null) : null;
    const error = err instanceof Error ? err.message : String(err);
    calls?.record({
      ...base,
      at,
      attempt,
      ok: false,
      status,
      terminal,
      error,
      ms: Date.now() - t0,
    });
    throw err;
  }
}

/**
 * `name`: `sites` on the box, `desk` on the Mac; one shape, two machines.
 * `calls`: every try of a call, one line each (`src/runs/calls.ts`).
 */
export function sitesService(
  facade: SiteFacade,
  name: string = SITES_SERVICE,
  calls?: SiteCalls,
  watchers?: Watchers | null,
  /** How a call waits for a busy browser profile; the defaults when absent. */
  o: { wait?: ProfileWait } = {},
) {
  const watching = () => {
    if (!watchers) throw new restate.TerminalError("no watchers here", { errorCode: 501 });
    return watchers;
  };
  return restate.service({
    name,
    handlers: {
      /** Lease (or renew) a tab watcher: `{site, account?, sink: {path, body}, until}`. */
      watch: async (ctx: restate.Context, raw: unknown) => {
        const w = watching();
        return ctx.run("watch", async () => {
          try {
            return await w.lease(raw);
          } catch (err) {
            if (err instanceof z.ZodError || /no watch spec/.test((err as Error).message))
              throw new restate.TerminalError((err as Error).message, { errorCode: 400 });
            throw err;
          }
        });
      },
      unwatch: async (ctx: restate.Context, raw: unknown) => {
        const { id } = parse(z.object({ id: z.string().min(1) }), raw);
        const w = watching();
        return ctx.run("unwatch", () => w.unwatch(id));
      },
      watches: async (ctx: restate.Context) => {
        const w = watching();
        return ctx.run("watches", () => w.states());
      },
      status: async (ctx: restate.Context, raw: unknown) => {
        const { site: which } = parse(site, raw);
        const step = `sites status ${which}`;
        return ctx.run(
          step,
          () => terminalOnSiteError(`${ctx.request().id} ${step}`, () => facade.status(which)),
          READ_RETRY,
        );
      },
      call: restate.handlers.handler(CALL_OPTS, async (ctx: restate.Context, raw: unknown) => {
        const req = parse(call, raw);
        const write = req.method !== "GET";
        const retry = write ? WRITE_RETRY : READ_RETRY;
        const from = {
          caller: req.caller ?? ctx.request().headers.get("x-caller") ?? null,
          invocation: ctx.request().id,
          ...(req.armId ? { armId: req.armId } : {}),
        };
        const step = `sites ${req.site} ${req.method} ${req.path}`;
        const base = {
          service: name,
          site: req.site,
          route: `${req.method} ${req.path}`,
          ...from,
        };
        let attempt = 0;
        return waitForProfile(
          ctx,
          step,
          () =>
            recorded(calls, base, ++attempt, () =>
              terminalOnSiteError(
                `${ctx.request().id} ${step}`,
                () => facade.call(req.site, req.method, req.path, req.input, req.account, from),
                // Writes run once; this bounds a read's retries.
                write ? undefined : attempt,
                write,
              ),
            ),
          // A write may take its profile from an explore session nobody is driving.
          { retry, take: write, ...(o.wait ? { wait: o.wait } : {}) },
        );
      }),
      /** The call's browser leg up to its last safe step, nothing sent: `{armed: id | null, until}`. */
      arm: async (ctx: restate.Context, raw: unknown) => {
        const req = parse(call, raw);
        const from = {
          caller: req.caller ?? ctx.request().headers.get("x-caller") ?? null,
          invocation: ctx.request().id,
          arm: true,
        };
        const step = `sites arm ${req.site} ${req.method} ${req.path}`;
        return waitForProfile(
          ctx,
          step,
          () =>
            terminalOnSiteError(`${ctx.request().id} ${step}`, () =>
              facade.call(req.site, req.method, req.path, req.input, req.account, from),
            ),
          { retry: WRITE_RETRY, ...(o.wait ? { wait: o.wait } : {}) },
        );
      },
      /** A day's capped reads: each bucket's use and every metered call, who asked, how it went. */
      caps: async (ctx: restate.Context, raw: unknown) => {
        const q = parse(
          z.object({
            day: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .optional(),
            site: z.string().min(1).optional(),
          }),
          raw ?? {},
        );
        return ctx.run(`sites caps ${q.day ?? "today"}`, () => facade.caps(q.day, q.site));
      },
      /** Make again what lapses within the window (a scheduler's daily call); lines say what happened. */
      renew: async (ctx: restate.Context, raw: unknown) => {
        const { dry } = parse(z.object({ dry: z.boolean().default(false) }), raw ?? {});
        if (!facade.renew)
          throw new restate.TerminalError("nothing lists what is kept here", { errorCode: 501 });
        const renew = facade.renew.bind(facade);
        const step = `sites renew${dry ? " (dry)" : ""}`;
        return ctx.run(
          step,
          () => withCall(`${ctx.request().id} ${step}`, () => renew({ dry })),
          WRITE_RETRY,
        );
      },
      setup: async (ctx: restate.Context, raw: unknown) => {
        const req = parse(setup, raw);
        const step = `sites setup ${req.site} ${req.step}`;
        return waitForProfile(
          ctx,
          step,
          () =>
            terminalOnSiteError(`${ctx.request().id} ${step}`, () =>
              facade.setup(req.site, req.step, req.account),
            ),
          { retry: WRITE_RETRY, ...(o.wait ? { wait: o.wait } : {}) },
        );
      },
    },
  });
}
export type SitesService = ReturnType<typeof sitesService>;
