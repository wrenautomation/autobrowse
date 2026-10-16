/**
 * `calls` on the desk: the portal's Record now / Stop and what the recorder is doing (wren's
 * packages/calendar/src/recorder.ts asks; no import across). An ask older than a minute is
 * refused: a Mac that slept through it must not start recording when it wakes.
 */
import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import type { Recorder, RecorderState } from "./recorder.js";

export const CALLS_SERVICE = "calls";
const STALE_MS = 60_000;

const Ask = z.object({ at: z.string(), by: z.string().optional() });

function fresh(raw: unknown): void {
  const r = Ask.safeParse(raw);
  if (!r.success) throw new restate.TerminalError(r.error.message, { errorCode: 400 });
  const at = Date.parse(r.data.at);
  if (Number.isNaN(at) || Date.now() - at > STALE_MS)
    throw new restate.TerminalError("Asked over a minute ago; ask again.", { errorCode: 409 });
}

export function callsService(recorder: Recorder) {
  const handler =
    (what: "status" | "start" | "stop") =>
    async (ctx: restate.Context, raw: unknown): Promise<RecorderState> => {
      fresh(raw);
      return ctx.run(what, () =>
        recorder[what]().catch((err: Error) => {
          // OBS missing or refusing is said, not retried: the person presses again.
          throw new restate.TerminalError(err.message, { errorCode: 503 });
        }),
      );
    };
  return restate.service({
    name: CALLS_SERVICE,
    handlers: { status: handler("status"), start: handler("start"), stop: handler("stop") },
  });
}

/** The 15 s check, one at a time; a failure is logged and the next check tries. */
export function watchCalls(
  recorder: Recorder,
  log: (msg: string) => void,
  everyMs = 15_000,
): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await recorder.tick();
    } catch (err) {
      log(`calls: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  };
  const t = setInterval(() => void tick(), everyMs);
  return () => clearInterval(t);
}

/** A Notification Center banner (osascript `display notification`): words only, no input. */
export async function macBanner(msg: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  await new Promise<void>((ok, fail) =>
    execFile(
      "/usr/bin/osascript",
      [
        "-e",
        "on run argv",
        "-e",
        'display notification (item 1 of argv) with title "Wren"',
        "-e",
        "end run",
        msg,
      ],
      (err) => (err ? fail(err) : ok()),
    ),
  );
}
