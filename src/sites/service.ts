/**
 * The site facade as the Restate service `sites`, for an orchestrator on the
 * same Restate (wren): `sites/call` is one official-API call, `sites/status`
 * the routes and setup rows, `sites/setup` one setup step. The worker dials
 * Restate, so a call queues while the box is down and answers when it is up:
 * no inbound port, no reachability from the caller's side. A `SiteError` is
 * terminal under its own status; a write runs once (an irreversible post is
 * never retried into a duplicate), a read retries like a browser leg.
 */
import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import type { SiteFacade } from "./facade.js";
import { SiteError } from "./types.js";

export const SITES_SERVICE = "sites";

const READ_RETRY = {
  maxRetryAttempts: 300,
  initialRetryInterval: 1_000,
  retryIntervalFactor: 2,
  maxRetryInterval: 300_000,
};
const WRITE_RETRY = { maxRetryAttempts: 1 };

const site = z.object({ site: z.string().min(1) });
const call = site.extend({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().startsWith("/"),
  input: z.record(z.string(), z.unknown()).default({}),
});
const setup = site.extend({ step: z.string().min(1) });

/** A request the shape rejects is the caller's mistake: terminal 400, nothing ran. */
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new restate.TerminalError(r.error.message, { errorCode: 400 });
  return r.data;
}

/** A SiteError is the caller's to read (404 route, 400 request, 501 no leg, 409 blocked, 502 failed); nothing else is. */
async function terminalOnSiteError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SiteError)
      throw new restate.TerminalError(err.message, { errorCode: err.status });
    throw err;
  }
}

export function sitesService(facade: SiteFacade) {
  return restate.service({
    name: SITES_SERVICE,
    handlers: {
      status: async (ctx: restate.Context, raw: unknown) => {
        const { site: name } = parse(site, raw);
        return ctx.run(
          `sites status ${name}`,
          () => terminalOnSiteError(() => facade.status(name)),
          READ_RETRY,
        );
      },
      call: async (ctx: restate.Context, raw: unknown) => {
        const req = parse(call, raw);
        const retry = req.method === "GET" ? READ_RETRY : WRITE_RETRY;
        return ctx.run(
          `sites ${req.site} ${req.method} ${req.path}`,
          () => terminalOnSiteError(() => facade.call(req.site, req.method, req.path, req.input)),
          retry,
        );
      },
      setup: async (ctx: restate.Context, raw: unknown) => {
        const req = parse(setup, raw);
        return ctx.run(
          `sites setup ${req.site} ${req.step}`,
          () => terminalOnSiteError(() => facade.setup(req.site, req.step)),
          WRITE_RETRY,
        );
      },
    },
  });
}
export type SitesService = ReturnType<typeof sitesService>;
