/**
 * Several keys for one paid API, keycycle style: `NUM_EXA=3` and
 * `EXA_API_KEY_1..3`, plus a plain `EXA_API_KEY` as the first. Calls take the
 * first live key; a key the API says is out of credit is marked spent until
 * the 1st of next month (UTC), on disk so a restart never retries it, and the
 * call moves to the next. Keys are named by a short hash; a value is never
 * written, logged or put in a message.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type SyncEnv = (name: string) => string | undefined;
export type AsyncEnv = (name: string) => Promise<string | undefined>;

/** When each spent key (by fingerprint) comes back, in epoch ms. */
export interface SpentKeys {
  until(fingerprint: string): number | null;
  mark(fingerprint: string, until: number): void;
}

export interface RingKey {
  /** The env name it came from (`EXA_API_KEY_2`). */
  name: string;
  value: string;
  fingerprint: string;
}

/** A key's name in the spent file: enough to tell keys apart, nothing to call with. */
export const fingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

/** The plain name, then `<BASE>_API_KEY_1..NUM_<BASE>`: every name a key of `base` may sit under. */
export const ringNames = (base: string, num: string | undefined): string[] => {
  const n = Math.min(Math.max(Number.parseInt(num ?? "", 10) || 0, 0), 50);
  return [`${base}_API_KEY`, ...Array.from({ length: n }, (_, i) => `${base}_API_KEY_${i + 1}`)];
};

/** Every key held for `base`, in order, the same value once. */
export async function ringKeys(base: string, env: AsyncEnv): Promise<RingKey[]> {
  const out: RingKey[] = [];
  for (const name of ringNames(base, await env(`NUM_${base}`))) {
    const value = (await env(name))?.trim();
    if (!value) continue;
    const fp = fingerprint(value);
    if (!out.some((k) => k.fingerprint === fp)) out.push({ name, value, fingerprint: fp });
  }
  return out;
}

/** `ringKeys` for a synchronous env (the facade's). */
export const ringKeysSync = (base: string, env: SyncEnv): Promise<RingKey[]> =>
  ringKeys(base, async (n) => env(n));

/** Held and live: how many of `base`'s keys can be called now. */
export async function ringCount(
  base: string,
  env: AsyncEnv,
  spent: SpentKeys,
  now = Date.now(),
): Promise<{ live: number; held: number }> {
  const keys = await ringKeys(base, env);
  const live = keys.filter((k) => (spent.until(k.fingerprint) ?? 0) <= now).length;
  return { live, held: keys.length };
}

/** 00:00 UTC on the 1st of the month after `now`: when a monthly free credit comes back. */
export const nextMonthUtc = (now: number): number => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};

/** The API says this key has no credit left: 402, or a 4xx that names credits or billing. */
export const outOfCredit = (status: number, body: string): boolean =>
  status === 402 ||
  (status >= 400 &&
    status < 500 &&
    /credits?\b|insufficient (funds|balance)|out of (credit|funds)|billing|payment required|exceeded your (plan|quota|limit)/i.test(
      body,
    ));

/** No key could be called: none held, or every one spent until `until`. */
export class NoLiveKey extends Error {
  constructor(
    readonly base: string,
    readonly held: number,
    readonly until: number | null,
  ) {
    super(
      held
        ? `every ${base} key is out of credit (${held} held) until ${new Date(until ?? 0).toISOString().slice(0, 10)}`
        : `no ${base}_API_KEY`,
    );
    this.name = "NoLiveKey";
  }
}

/**
 * Call with the first live key; on out-of-credit, mark it spent and try the
 * next. `send` returns the raw Response; anything else it does (an error, a
 * non-credit 4xx or 5xx) is the caller's, unchanged.
 */
export async function withKey(
  base: string,
  env: AsyncEnv,
  spent: SpentKeys,
  send: (key: string) => Promise<Response>,
  now: () => number = Date.now,
): Promise<Response> {
  const keys = await ringKeys(base, env);
  let soonest: number | null = null;
  for (const k of keys) {
    const back = spent.until(k.fingerprint);
    if (back && back > now()) {
      soonest = soonest === null ? back : Math.min(soonest, back);
      continue;
    }
    const res = await send(k.value);
    if (res.status < 400) return res;
    const body = await res
      .clone()
      .text()
      .catch(() => "");
    if (!outOfCredit(res.status, body)) return res;
    const until = nextMonthUtc(now());
    spent.mark(k.fingerprint, until);
    soonest = soonest === null ? until : Math.min(soonest, until);
  }
  throw new NoLiveKey(base, keys.length, soonest);
}

/** Spent marks in memory: tests, and a process with no file. */
export function memorySpent(): SpentKeys {
  const marks = new Map<string, number>();
  return { until: (fp) => marks.get(fp) ?? null, mark: (fp, until) => void marks.set(fp, until) };
}

/** Spent marks in a JSON file (`{ fingerprint: until }`), read per call so two processes agree. */
export function fileSpent(path: string): SpentKeys {
  const read = (): Record<string, number> => {
    try {
      return existsSync(path)
        ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, number>)
        : {};
    } catch {
      return {};
    }
  };
  return {
    until: (fp) => read()[fp] ?? null,
    mark(fp, until) {
      const all = { ...read(), [fp]: until };
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}
