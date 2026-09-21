/**
 * `do` as a Restate service for an orchestrator on the same Restate (wren):
 * `do/run` is one goal. The whole call is one durable step: it queues while
 * the box is down and runs once, so a goal that publishes is never retried
 * into a duplicate. A `DoError` is the caller's to read (400 bad request,
 * 501 nothing does it and no model).
 */
import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import { DoError, type Doer } from "./doer.js";

export const DO_SERVICE = "do";

const request = z.object({
  goal: z.string().min(1),
  inputs: z.record(z.string(), z.string()).default({}),
  site: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  dryRun: z.boolean().default(false),
});

export function doService(verb: () => Doer | null) {
  return restate.service({
    name: DO_SERVICE,
    handlers: {
      run: async (ctx: restate.Context, raw: unknown) => {
        const r = request.safeParse(raw);
        if (!r.success) throw new restate.TerminalError(r.error.message, { errorCode: 400 });
        return ctx.run(
          `do ${r.data.goal.slice(0, 60)}`,
          async () => {
            const d = verb();
            if (!d) throw new restate.TerminalError("do is not wired here", { errorCode: 503 });
            try {
              return await d.do(r.data);
            } catch (err) {
              if (err instanceof DoError)
                throw new restate.TerminalError(err.message, { errorCode: err.status });
              throw err;
            }
          },
          { maxRetryAttempts: 1 },
        );
      },
    },
  });
}
