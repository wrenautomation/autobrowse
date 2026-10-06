/**
 * `studio` on the desk: wren's video editor work that needs this Mac (designs/2026-10-06-video-
 * editor.md in wren, step 4). `studio/render` is one render the Videos page asked for:
 * `wren video render <id> --cut` against prod, which writes its own state on the row. While the
 * Mac is off the call waits in Restate. `watchRecordings` runs `wren video watch` every minute:
 * each finished OBS or Cap recording becomes a video, once.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";

export const STUDIO_SERVICE = "studio";

/** A long talk renders in well under this; past it something hangs. */
const RENDER_MS = 2 * 3600_000;
const WATCH_MS = 60_000;

export type Wren = (args: string[], timeoutMs: number) => Promise<string>;

/** `node scripts/prod-wren.mjs <args>` in the wren checkout beside this one. */
export const wrenIn =
  (root: string): Wren =>
  (args, timeoutMs) =>
    new Promise((ok, fail) =>
      execFile(
        "node",
        ["scripts/prod-wren.mjs", ...args],
        { cwd: join(root, "wren"), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (!err) return ok(stdout);
          const why = err.killed ? `took over ${timeoutMs / 60_000} minutes` : `exit ${err.code}`;
          // The CLI's last lines say what broke.
          fail(new Error(`${why}: ${(stderr || stdout).trim().slice(-400)}`));
        },
      ),
    );

export const renderArgs = (id: number) => ["video", "render", String(id), "--cut"];

export function studioService(wren: Wren, name: string = STUDIO_SERVICE) {
  return restate.service({
    name,
    handlers: {
      render: async (ctx: restate.Context, raw: unknown): Promise<{ ms: number }> => {
        const r = z.object({ id: z.number().int().positive() }).safeParse(raw);
        if (!r.success) throw new restate.TerminalError(r.error.message, { errorCode: 400 });
        return ctx.run("render", async () => {
          const t0 = Date.now();
          // A failed render is reported, not retried: the page shows why, and Render again.
          await wren(renderArgs(r.data.id), RENDER_MS).catch((err: Error) => {
            throw new restate.TerminalError(`render: ${err.message}`);
          });
          return { ms: Date.now() - t0 };
        });
      },
    },
    // A render runs for minutes; Restate's default 10 minute abort would cut it off.
    options: { inactivityTimeout: RENDER_MS, abortTimeout: RENDER_MS },
  });
}

/** `wren video watch` every minute, one at a time; a failure is logged and the next minute tries. */
export function watchRecordings(wren: Wren, log: (msg: string) => void): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const out = (await wren(["video", "watch"], 3600_000)).trim();
      if (out && !out.startsWith("no OBS profile")) log(out);
    } catch (err) {
      log(`video watch: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  };
  const t = setInterval(() => void tick(), WATCH_MS);
  return () => clearInterval(t);
}
