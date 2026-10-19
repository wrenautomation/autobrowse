/**
 * Several keys for one paid API. The keys live in the vault (`creds key`,
 * `key-source.ts` reads them) and are projected to env as `NUM_EXA=3` and
 * `EXA_API_KEY_1..3`, plus a plain `EXA_API_KEY` as the first; the env names
 * are the ring when the vault has none or does not answer. Calls take the
 * first live key; a key the API says is out of credit is marked spent until
 * the 1st of next month (UTC), on disk so a restart never retries it, and the
 * call moves to the next. A call that names a key (`account`) runs on that
 * key only. Keys are named by a short hash; a value is never written,
 * logged or put in a message.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { keyId, vendorBase } from "credvault";

export type SyncEnv = (name: string) => string | undefined;
export type AsyncEnv = (name: string) => Promise<string | undefined>;

/** When each spent key (by fingerprint) comes back, in epoch ms. */
export interface SpentKeys {
  until(fingerprint: string): number | null;
  mark(fingerprint: string, until: number): void;
}

export interface RingKey {
  /** The env name it came from (`EXA_API_KEY_2`), or the vault address. */
  name: string;
  value: string;
  fingerprint: string;
  /** The same as `fingerprint`: how a log line names the key. */
  id: string;
  /** `site@account` for a vault key; null for a key that only sits in env. */
  address: string | null;
  /** The vault key's monthly cap. */
  cap?: { amount: number; unit: "calls" | "micros" };
}

/** A key's name in the spent file: enough to tell keys apart, nothing to call with. */
export const fingerprint = keyId;

/** Asks for the keys of a vendor (`exa`), in ring order; `account` names one key (`exa@env-1`) and nothing else may answer. */
export type KeySource = (
  vendor: string,
  o: { account?: string | undefined; purpose?: string | undefined },
) => Promise<RingKey[]>;

const vendorOf = (base: string): string => base.toLowerCase().replace(/_/g, "-");

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
    if (!out.some((k) => k.fingerprint === fp))
      out.push({ name, value, fingerprint: fp, id: fp, address: null });
  }
  return out;
}

/** The env names as a key source: no addresses, so a named account finds nothing. */
export const envSource =
  (env: AsyncEnv): KeySource =>
  async (vendor, o) => {
    if (o.account)
      throw new NoLiveKey(vendorBase(vendor), 0, null, {
        account: o.account,
        message: `no key ${o.account}`,
      });
    return ringKeys(vendorBase(vendor), env);
  };

/** Held and live: how many of `base`'s keys can be called now. */
export async function ringCount(
  base: string,
  source: KeySource,
  spent: SpentKeys,
  now = Date.now(),
): Promise<{ live: number; held: number }> {
  const keys = await source(vendorOf(base), {});
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

/**
 * No key could be called: none held, or every one spent until `until`. With
 * `account` the call named one key and no other may answer: `message` says why
 * that key cannot.
 */
export class NoLiveKey extends Error {
  readonly account: string | undefined;
  constructor(
    readonly base: string,
    readonly held: number,
    readonly until: number | null,
    o: { account?: string; message?: string } = {},
  ) {
    super(
      o.message ??
        (held
          ? `every ${base} key is out of credit (${held} held) until ${new Date(until ?? 0).toISOString().slice(0, 10)}`
          : `no ${base}_API_KEY`),
    );
    this.name = "NoLiveKey";
    this.account = o.account;
  }
}

/** Calls per key per month: the count a `calls` cap is checked against. */
export interface KeyUses {
  count(id: string, month: string): number;
  add(id: string, month: string): void;
}

/** `2026-10`: the month a call counts in (UTC). */
export const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

export interface WithKeyOptions {
  /** Run on this key (`exa@env-1`) only; no other key answers. */
  account?: string | undefined;
  /** The key holding this purpose goes first. */
  purpose?: string | undefined;
  /** Before each send, with the key it goes on. A throw stops the call. */
  onUse?: ((key: RingKey) => void | Promise<void>) | undefined;
  /** A named key that cannot be used, and why. */
  onRefuse?: ((account: string, why: string) => void | Promise<void>) | undefined;
  /** Counts calls for `calls` caps. */
  uses?: KeyUses | undefined;
  now?: (() => number) | undefined;
}

/**
 * Call with the first live key; on out-of-credit, mark it spent and try the
 * next. `send` returns the raw Response; anything else it does (an error, a
 * non-credit 4xx or 5xx) is the caller's, unchanged. A key whose `calls` cap
 * for this month is reached is marked spent until the 1st and skipped.
 */
export async function withKey(
  base: string,
  source: KeySource,
  spent: SpentKeys,
  send: (key: string) => Promise<Response>,
  o: WithKeyOptions = {},
): Promise<Response> {
  const now = o.now ?? Date.now;
  let keys: RingKey[];
  try {
    keys = await source(vendorOf(base), { account: o.account, purpose: o.purpose });
  } catch (e) {
    if (e instanceof NoLiveKey && o.account) await o.onRefuse?.(o.account, e.message);
    throw e;
  }
  let soonest: number | null = null;
  let sent = false;
  for (const k of keys) {
    const back = spent.until(k.fingerprint);
    if (back && back > now()) {
      soonest = soonest === null ? back : Math.min(soonest, back);
      continue;
    }
    if (o.uses && k.cap?.unit === "calls" && o.uses.count(k.id, monthOf(now())) >= k.cap.amount) {
      const until = nextMonthUtc(now());
      spent.mark(k.fingerprint, until);
      soonest = soonest === null ? until : Math.min(soonest, until);
      continue;
    }
    await o.onUse?.(k);
    sent = true;
    if (o.uses && k.cap?.unit === "calls") o.uses.add(k.id, monthOf(now()));
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
  if (!o.account) throw new NoLiveKey(base, keys.length, soonest);
  const why = `${o.account} is spent until ${new Date(soonest ?? 0).toISOString().slice(0, 10)}`;
  if (!sent) await o.onRefuse?.(o.account, why);
  throw new NoLiveKey(base, keys.length, soonest, { account: o.account, message: why });
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

/** Monthly call counts in memory: tests. */
export function memoryKeyUses(): KeyUses {
  const counts = new Map<string, number>();
  return {
    count: (id, month) => counts.get(`${id} ${month}`) ?? 0,
    add: (id, month) => void counts.set(`${id} ${month}`, (counts.get(`${id} ${month}`) ?? 0) + 1),
  };
}

/** Monthly call counts in a JSON file (`{ id: { month, calls } }`), read per call so two processes agree. */
export function fileKeyUses(path: string): KeyUses {
  type Rows = Record<string, { month: string; calls: number }>;
  const read = (): Rows => {
    try {
      return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Rows) : {};
    } catch {
      return {};
    }
  };
  return {
    count: (id, month) => {
      const row = read()[id];
      return row?.month === month ? row.calls : 0;
    },
    add(id, month) {
      const all = read();
      const row = all[id];
      all[id] = { month, calls: row?.month === month ? row.calls + 1 : 1 };
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}
