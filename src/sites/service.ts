/**
 * The site facade as the Restate service `sites`, for an orchestrator on the
 * same Restate (wren): `sites/call` is one official-API call, `sites/status`
 * the routes and setup rows, `sites/setup` one setup step, `sites/renew` every token about to lapse,
 * `sites/caps` a day's capped reads and who made them. The worker dials
 * Restate, so a call queues while the box is down and answers when it is up:
 * no inbound port, no reachability from the caller's side. A `SiteError` is
 * terminal under its own status; a write runs once (an irreversible post is
 * never retried into a duplicate), a read retries like a browser leg.
 */
import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import { withCall } from "../browser/attempt.js";
import { lastingRefusal } from "../clients/http.js";
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

/** `account`: which identity's token (a consented address); the site's own when absent. */
const site = z.object({ site: z.string().min(1), account: z.string().min(1).optional() });
const call = site.extend({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().startsWith("/"),
  input: z.record(z.string(), z.unknown()).default({}),
  /** Who is asking (`wren:demo`), for the caps ledger; the `x-caller` header says it too. */
  caller: z.string().min(1).max(120).optional(),
});
const setup = site.extend({ step: z.string().min(1) });

/** A request the shape rejects is the caller's mistake: terminal 400, nothing ran. */
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new restate.TerminalError(r.error.message, { errorCode: 400 });
  return r.data;
}

/**
 * A SiteError is the caller's to read (404 route, 400 request, 501 no leg, 409 blocked, 502 failed),
 * and so is a platform's lasting refusal; nothing else is.
 * Runs as the durable call `key`: a browser leg's irreversible act (a post) that went
 * through before a crash or a lost connection is not done again when Restate reruns it.
 */
async function terminalOnSiteError<T>(key: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await withCall(key, fn);
  } catch (err) {
    if (err instanceof SiteError || lastingRefusal(err))
      throw new restate.TerminalError(err.message, { errorCode: err.status });
    throw err;
  }
}

/**
 * A call can be one long step: a video's bytes run for minutes. Restate's default timeouts cut
 * such a step off mid-upload (every ~3 minutes on 10-07) and rerun it, so the bytes never finish.
 */
const CALL_MS = 2 * 60 * 60_000;
const CALL_OPTS = { inactivityTimeout: CALL_MS, abortTimeout: CALL_MS };

/** `name`: `sites` on the box, `desk` on the Mac; one shape, two machines. */
export function sitesService(facade: SiteFacade, name: string = SITES_SERVICE) {
  return restate.service({
    name,
    handlers: {
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
        const retry = req.method === "GET" ? READ_RETRY : WRITE_RETRY;
        const from = {
          caller: req.caller ?? ctx.request().headers.get("x-caller") ?? null,
          invocation: ctx.request().id,
        };
        const step = `sites ${req.site} ${req.method} ${req.path}`;
        return ctx.run(
          step,
          () =>
            terminalOnSiteError(`${ctx.request().id} ${step}`, () =>
              facade.call(req.site, req.method, req.path, req.input, req.account, from),
            ),
          retry,
        );
      }),
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
        return ctx.run(
          step,
          () =>
            terminalOnSiteError(`${ctx.request().id} ${step}`, () =>
              facade.setup(req.site, req.step, req.account),
            ),
          WRITE_RETRY,
        );
      },
    },
  });
}
export type SitesService = ReturnType<typeof sitesService>;
