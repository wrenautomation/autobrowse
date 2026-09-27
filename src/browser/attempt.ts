/**
 * Which durable call a browser run belongs to. Restate retries a step by
 * running it again, and an interrupted run has closed its browser, so the
 * flow replays from its start: the page state is gone. What must not replay
 * is an irreversible act that already went through (a post, a token made, a
 * payment). It is written down under the call's key the moment it
 * succeeds; a retry of the same call stops there and asks a person instead
 * of doing it twice.
 */
import { AsyncLocalStorage } from "node:async_hooks";
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

const calls = new AsyncLocalStorage<string>();

/** Run `fn` as part of the durable call `key` (invocation id + step name). */
export const withCall = <T>(key: string, fn: () => Promise<T>): Promise<T> => calls.run(key, fn);

/** The durable call this code runs under, or null (a local run: nothing retries it). */
export const currentCall = (): string | null => calls.getStore() ?? null;

export interface DoneActs {
  /** Whether this call already did this irreversible act on an earlier try. */
  has(call: string, act: string): boolean;
  add(call: string, act: string): void;
}

/** A record outlives this long; Restate gives up on a step well before. */
const KEEP_MS = 7 * 24 * 3_600_000;

/**
 * One small file per call that did an irreversible act; most calls never
 * write one. Invocation ids never repeat, so a record is never cleared on
 * success, only aged out.
 */
export function fileDoneActs(dir: string, now: () => number = Date.now): DoneActs {
  const file = (call: string) =>
    join(dir, `${createHash("sha256").update(call).digest("hex").slice(0, 32)}.json`);
  const read = (call: string): { at: number; acts: string[] } | null => {
    try {
      const got = JSON.parse(readFileSync(file(call), "utf8")) as { at: number; acts: string[] };
      return now() - got.at < KEEP_MS ? got : null;
    } catch {
      return null;
    }
  };
  return {
    has: (call, act) => read(call)?.acts.includes(act) ?? false,
    add(call, act) {
      const acts = [...(read(call)?.acts ?? []), act];
      mkdirSync(dir, { recursive: true });
      for (const f of readdirSync(dir))
        try {
          if (now() - statSync(join(dir, f)).mtimeMs > KEEP_MS)
            rmSync(join(dir, f), { force: true });
        } catch {
          // gone already
        }
      const tmp = `${file(call)}.tmp`;
      writeFileSync(tmp, JSON.stringify({ at: now(), acts }), { mode: 0o600 });
      renameSync(tmp, file(call));
    },
  };
}
