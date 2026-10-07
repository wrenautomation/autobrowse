/**
 * Resumable uploads that survive a dropped connection. A site's resumable
 * upload answers a session URL, and the bytes go to it; the session says how
 * far it got and, once whole, answers the finished resource. Kept by durable
 * call (`currentCall`), so when Restate reruns the call the rerun asks the
 * same session and sends only the rest. Bytes never start over, and a
 * session that finished before the connection dropped answers its resource
 * instead of a second copy being made.
 *
 * Within one process, a rerun of a call whose upload is still sending joins
 * that upload: two writers on one session would corrupt it.
 */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface UploadSessions {
  /** The session URL this call's upload sends to, or null. */
  get(call: string): string | null;
  set(call: string, session: string): void;
}

/** Google keeps a resumable session about a week. */
const KEEP_MS = 7 * 24 * 3_600_000;

/** One small file per call, mode 600 (a session URL takes bytes without a bearer); aged out, never cleared. */
export function fileUploadSessions(dir: string, now: () => number = Date.now): UploadSessions {
  const file = (call: string) =>
    join(dir, `${createHash("sha256").update(call).digest("hex").slice(0, 32)}.json`);
  return {
    get(call) {
      try {
        const got = JSON.parse(readFileSync(file(call), "utf8")) as { at: number; session: string };
        return now() - got.at < KEEP_MS ? got.session : null;
      } catch {
        return null;
      }
    },
    set(call, session) {
      mkdirSync(dir, { recursive: true });
      for (const f of readdirSync(dir))
        try {
          if (now() - statSync(join(dir, f)).mtimeMs > KEEP_MS)
            rmSync(join(dir, f), { force: true });
        } catch {
          // gone already
        }
      const tmp = `${file(call)}.tmp`;
      writeFileSync(tmp, JSON.stringify({ at: now(), session }), { mode: 0o600 });
      renameSync(tmp, file(call));
    },
  };
}

const sending = new Map<string, Promise<unknown>>();

/** Run `fn` once per call at a time in this process; a second caller for the same call gets the first's answer. */
export function once<T>(call: string | null, fn: () => Promise<T>): Promise<T> {
  if (!call) return fn();
  const running = sending.get(call);
  if (running) return running as Promise<T>;
  const p = fn().finally(() => sending.delete(call));
  sending.set(call, p);
  return p;
}
