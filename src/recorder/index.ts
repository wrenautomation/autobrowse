/**
 * `recordChore`: the browser leg (with play/pause and notes from a
 * terminal), then an optional terminal leg, then the manifest.
 *
 * Terminal keys while the browser is open: `p` pause/play, `q` finish,
 * anything else is a note at this point in the chore.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserOptions } from "../browser/session.js";
import { openSession } from "../browser/session.js";
import { recorderControl, startBrowserRecording } from "./browser.js";
import { recordingDir, saveRecording } from "./store.js";
import { recordTerminal } from "./terminal.js";
import type { Recording } from "./types.js";

export interface RecordOptions {
  name: string;
  site: string;
  startUrl: string | null;
  terminal: boolean;
  recordingsDir: string;
  browser: BrowserOptions;
  io: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream };
}

export async function recordChore(opts: RecordOptions): Promise<string> {
  const dir = recordingDir(opts.recordingsDir, opts.name);
  await mkdir(dir, { recursive: true });
  const startedAt = new Date().toISOString();
  const control = recorderControl();
  const session = await openSession(opts.site, { ...opts.browser, headless: false });

  opts.io.stdout.write("recording. p = pause/play, q = finish, other text = note\n");
  const onLine = (buf: Buffer) => {
    const line = buf.toString("utf8").trim();
    if (line === "p") {
      if (control.paused) {
        control.play();
        opts.io.stdout.write("▶ recording\n");
      } else {
        control.pause();
        opts.io.stdout.write("⏸ paused (nothing is captured)\n");
      }
    } else if (line === "q") control.stop();
    else if (line) {
      control.note(line);
      opts.io.stdout.write("noted\n");
    }
  };
  opts.io.stdin.on("data", onLine);
  const active = await startBrowserRecording({ session, dir, startUrl: opts.startUrl, control });
  const browser = await active.finished;
  opts.io.stdin.off("data", onLine);

  let terminal: string | null = null;
  let commands: string[] = [];
  if (opts.terminal) {
    opts.io.stdout.write("terminal leg: do the shell part, then `exit`\n");
    terminal = "terminal.log";
    ({ commands } = await recordTerminal({ file: join(dir, terminal) }));
  }

  const rec: Recording = {
    name: opts.name,
    site: opts.site,
    startedAt,
    finishedAt: new Date().toISOString(),
    actions: browser.actions,
    trace: browser.trace,
    terminal,
    commands,
  };
  return saveRecording(opts.recordingsDir, rec);
}

export { type RecorderControl, recorderControl } from "./browser.js";
export {
  listRecordingSummaries,
  listRecordings,
  loadRecording,
  recordingDir,
  saveRecording,
} from "./store.js";
export * from "./types.js";
