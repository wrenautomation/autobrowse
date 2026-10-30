/**
 * The send journal (designs/2026-10-16-send-verdicts.md): per send key, what this machine knows
 * of one keyed write. It outlives the process. Restate gives a call back its failure; this file
 * says whether the write went out. One small JSON file per key, written whole (tmp + rename), so
 * a crash leaves the old record or the new one, never half of one.
 *
 * The order that matters: `start` before the leg runs, `submitted` on disk before the act
 * (`markSubmitted`'s hook), the verdict last. A key that is started and never submitted, with no
 * call running it, did not send. A key that is submitted with no verdict may have.
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
import { isFinal, type SendVerdict } from "./verdict.js";

/** A record outlives this long, aged out like `fileDoneActs`. */
export const KEEP_MS = 30 * 24 * 3_600_000;

/** What is kept per send key. */
export interface SendRecord {
  key: string;
  site: string;
  method: string;
  path: string;
  /** The account the caller named; null when the policy picked one. */
  account: string | null;
  /** The request as sent: the verify read needs its words. */
  input: Record<string, unknown>;
  /** ISO. The verify read matches rows made since then. */
  startedAt: string;
  /** The submit step started (an irreversible click, the write's HTTP request). */
  submitted: boolean;
  /** Absent until the call or a verify read settles it. */
  verdict?: SendVerdict;
  /** Verify reads made so far. */
  tries: number;
  /** ISO. The last verify read began; a site's `VERIFY_GAP_MS` counts from it. */
  readAt?: string;
}

/** What a new record is made from. */
export type SendStart = Pick<SendRecord, "key" | "site" | "method" | "path" | "account" | "input">;

export interface SendJournal {
  get(key: string): SendRecord | null;
  /** Begin a record for a key that has none; `submitted` false, no verdict. */
  start(s: SendStart): SendRecord;
  /** The submit step starts now. Synchronous: it is on disk before this returns. */
  submitted(key: string): void;
  /**
   * Keep a verdict. A final one stands: a later one never replaces it. An `unknown` is replaced
   * by any later verdict. Answers the verdict that stands (the one passed when the key has no
   * record any more).
   */
  settle(key: string, verdict: SendVerdict): SendVerdict;
  /** One more verify read made. */
  tried(key: string, at?: Date): void;
  /** Drop a record that never submitted (a busy profile, a bad request): nothing was asked of the site. */
  forget(key: string): void;
  /** A call in this process is running this key's leg. Not kept on disk: a restart clears it. */
  live(key: string): boolean;
  enter(key: string): void;
  leave(key: string): void;
}

/** Where records live: a directory, or a map for tests. */
interface Store {
  read(key: string): SendRecord | null;
  write(rec: SendRecord): void;
  remove(key: string): void;
  /** Drop what is older than `KEEP_MS`. */
  sweep(): void;
}

function journalOver(store: Store, now: () => number): SendJournal {
  const running = new Set<string>();
  const alive = (rec: SendRecord | null): SendRecord | null =>
    rec && now() - new Date(rec.startedAt).getTime() < KEEP_MS ? rec : null;
  const update = (key: string, change: (r: SendRecord) => SendRecord): void => {
    const rec = alive(store.read(key));
    if (rec) store.write(change(rec));
  };
  return {
    get: (key) => alive(store.read(key)),
    start(s) {
      store.sweep();
      const rec: SendRecord = {
        ...s,
        startedAt: new Date(now()).toISOString(),
        submitted: false,
        tries: 0,
      };
      store.write(rec);
      return rec;
    },
    submitted(key) {
      update(key, (r) => ({ ...r, submitted: true }));
    },
    settle(key, verdict) {
      let standing = verdict;
      update(key, (r) => {
        if (r.verdict && isFinal(r.verdict)) {
          standing = r.verdict;
          return r;
        }
        return { ...r, verdict };
      });
      return standing;
    },
    tried(key, at = new Date()) {
      update(key, (r) => ({ ...r, tries: r.tries + 1, readAt: at.toISOString() }));
    },
    forget(key) {
      const rec = store.read(key);
      if (rec && !rec.submitted) store.remove(key);
    },
    live: (key) => running.has(key),
    enter: (key) => void running.add(key),
    leave: (key) => void running.delete(key),
  };
}

/** Records in memory: tests, and a process that wants no disk. */
export function memorySendJournal(now: () => number = Date.now): SendJournal {
  const map = new Map<string, SendRecord>();
  return journalOver(
    {
      read: (key) => {
        const r = map.get(key);
        return r ? structuredClone(r) : null;
      },
      write: (rec) => void map.set(rec.key, structuredClone(rec)),
      remove: (key) => void map.delete(key),
      sweep: () => {},
    },
    now,
  );
}

/**
 * One file per key under `dir`, named by the key's sha256, mode 0600. A file that will not parse
 * reads as a send that may have gone out with no verdict, so a rerun verifies and never writes.
 */
export function fileSendJournal(dir: string, now: () => number = Date.now): SendJournal {
  const file = (key: string) => join(dir, `${createHash("sha256").update(key).digest("hex")}.json`);
  return journalOver(
    {
      read(key) {
        let text: string;
        try {
          text = readFileSync(file(key), "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw err;
        }
        try {
          return JSON.parse(text) as SendRecord;
        } catch {
          const since = new Date(now()).toISOString();
          return {
            key,
            site: "",
            method: "",
            path: "",
            account: null,
            input: {},
            startedAt: since,
            submitted: true,
            verdict: { verdict: "unknown", reason: "the journal record is unreadable", since },
            tries: 0,
          };
        }
      },
      write(rec) {
        mkdirSync(dir, { recursive: true });
        const tmp = `${file(rec.key)}.tmp`;
        writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
        renameSync(tmp, file(rec.key));
      },
      remove: (key) => rmSync(file(key), { force: true }),
      sweep() {
        mkdirSync(dir, { recursive: true });
        for (const f of readdirSync(dir))
          try {
            if (now() - statSync(join(dir, f)).mtimeMs > KEEP_MS)
              rmSync(join(dir, f), { force: true });
          } catch {
            // gone already
          }
      },
    },
    now,
  );
}
