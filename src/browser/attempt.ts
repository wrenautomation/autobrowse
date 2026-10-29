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

/** One try of a durable call: its key, and whether its submit step started. */
export interface CallTry {
  key: string;
  /**
   * The act that sends started (an irreversible click, a write's HTTP request): a failure
   * after it may have gone through. Before it, nothing left this machine.
   */
  submitted: boolean;
  /**
   * Runs once, synchronously, as the submit step starts and before the act: the send journal
   * writes `submitted` to disk here (`sites/send-journal.ts`). If it throws, the act never runs.
   */
  onSubmit?: () => void;
  /**
   * The leg found what it was asked for already there (the name already set, the org already
   * made): an answer with no submit step still counts as done (`markAlready`).
   */
  already?: boolean;
}

const calls = new AsyncLocalStorage<CallTry>();

/**
 * Run `fn` as part of the durable call `key` (invocation id + step name). Pass `t` to read
 * afterwards whether its submit step started.
 */
export const withCall = <T>(
  key: string,
  fn: () => Promise<T>,
  t: CallTry = { key, submitted: false },
): Promise<T> => calls.run(t, fn);

/** The durable call this code runs under, or null (a local run: nothing retries it). */
export const currentCall = (): string | null => calls.getStore()?.key ?? null;

/**
 * What one metered call did at the site (`sites/facade.ts` settles its cap from it): `reached`,
 * the site answered a request; `already`, the thing was there and nothing was done.
 */
export interface Reach {
  reached: boolean;
  already?: boolean;
}

const reaches = new AsyncLocalStorage<Reach>();

export const withReach = <T>(r: Reach, fn: () => Promise<T>): Promise<T> => reaches.run(r, fn);

/** The metered call this code runs under, or null. */
export const currentReach = (): Reach | null => reaches.getStore() ?? null;

/** A request went to the site. */
export const markReached = (): void => {
  const r = reaches.getStore();
  if (r) r.reached = true;
};

/** The step that sends starts now: from here a failure may have gone through. */
export const markSubmitted = (): void => {
  markReached();
  const t = calls.getStore();
  if (!t || t.submitted) return;
  t.onSubmit?.();
  t.submitted = true;
};

/**
 * The leg answers with no act because the thing is already there: a keyed irreversible call
 * then settles as sent. Without it, such a call's answer with no submit step is `not_sent`.
 */
export const markAlready = (): void => {
  const t = calls.getStore();
  if (t) t.already = true;
  const r = reaches.getStore();
  if (r) r.already = true;
};

/** `out`, answered as already there (`markAlready`). */
export const already = <T>(out: T): T => {
  markAlready();
  return out;
};

export interface DoneActs {
  /** Whether this call already did this irreversible act on an earlier try. */
  has(call: string, act: string): boolean;
  add(call: string, act: string): void;
}

/** A record outlives this long; Restate gives up on a step well before. */
export const KEEP_MS = 7 * 24 * 3_600_000;

/** One call's file in `dir`: the key hashed, so no invocation id lands in a file name. */
export const callFile = (dir: string, call: string): string =>
  join(dir, `${createHash("sha256").update(call).digest("hex").slice(0, 32)}.json`);

/** Drop the files in `dir` older than `KEEP_MS`. */
export function ageOut(dir: string, now: () => number = Date.now): void {
  for (const f of readdirSync(dir))
    try {
      if (now() - statSync(join(dir, f)).mtimeMs > KEEP_MS) rmSync(join(dir, f), { force: true });
    } catch {
      // gone already
    }
}

/** Write a call's file whole (a temp file, then a rename), owner-only, after an age-out. */
export function writeCallFile(dir: string, call: string, body: unknown, now = Date.now): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  ageOut(dir, now);
  const tmp = `${callFile(dir, call)}.tmp`;
  writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
  renameSync(tmp, callFile(dir, call));
}

/**
 * One small file per call that did an irreversible act; most calls never
 * write one. Invocation ids never repeat, so a record is never cleared on
 * success, only aged out.
 */
export function fileDoneActs(dir: string, now: () => number = Date.now): DoneActs {
  const read = (call: string): { at: number; acts: string[] } | null => {
    try {
      const got = JSON.parse(readFileSync(callFile(dir, call), "utf8")) as {
        at: number;
        acts: string[];
      };
      return now() - got.at < KEEP_MS ? got : null;
    } catch {
      return null;
    }
  };
  return {
    has: (call, act) => read(call)?.acts.includes(act) ?? false,
    add(call, act) {
      const acts = [...(read(call)?.acts ?? []), act];
      writeCallFile(dir, call, { at: now(), acts }, now);
    },
  };
}
