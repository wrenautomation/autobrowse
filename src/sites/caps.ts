/**
 * Daily caps on a site's reads, per account: LinkedIn lets a person look at
 * so many profiles a day before it restricts the account, and one account's
 * reads never spend another's. A call takes all its buckets or none; over a
 * cap it is refused with the seconds until the day turns (UTC), never queued.
 *
 * Two counts per bucket: `used` (calls that worked, and those in flight) stays under the cap;
 * `tried` (every call that reached the site, worked or not) stays under the cap plus a buffer,
 * so a few failures leave room to try again and a broken flow still stops. A call that never
 * reached the site (its profile busy, the browser down) spends neither (`giveBack`).
 *
 * Pace: a person does not open ten profiles in ten seconds. A paced site
 * books each call a slot at least `gapMs` (plus up to `jitterMs`, random)
 * after the last one for that account; the caller sleeps until it. A slot
 * further out than `maxWaitMs` is refused like a cap, with its seconds.
 *
 * Who spent it: every metered call is noted (caller, route, outcome), a file
 * per UTC day beside the caps file, kept two weeks.
 */
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface Taken {
  ok: boolean;
  /** The bucket that was full, when refused. */
  bucket?: string;
  used?: number;
  cap?: number;
  /** The tries ceiling (cap plus buffer) was full, not the cap itself. */
  tries?: true;
  /** Seconds until the day turns. */
  retryAfter?: number;
}

/** Spacing between one account's calls to a site. */
export interface Pace {
  gapMs: number;
  jitterMs?: number;
  /** A wait past this is a refusal (429) instead: default two minutes. */
  maxWaitMs?: number;
}

export interface Slot {
  ok: boolean;
  /** Milliseconds to sleep before the call, when booked. */
  waitMs: number;
  /** Seconds until a slot this far out would be booked, when refused. */
  retryAfter?: number;
}

export interface DailyCaps {
  /** `buffer`: the tries allowed over each cap, as a fraction of it (0.25 = a quarter more). */
  take(
    site: string,
    account: string,
    use: Record<string, number>,
    caps: Record<string, number>,
    buffer?: number,
  ): Taken;
  /**
   * Undo a `take`. `reached` false: the call never reached the site, both counts return.
   * `reached` true: it reached the site and did not do the thing, only `used` returns.
   */
  giveBack(site: string, account: string, use: Record<string, number>, reached?: boolean): void;
  /** Book the next slot for `site|account` under `pace`; nothing is booked when refused. */
  slot(site: string, account: string, pace: Pace): Slot;
  /** What each bucket has used today, by `site|account|bucket`. */
  today(): Record<string, number>;
  /** Each bucket's tries today (`used` plus the failures that reached the site). */
  tried(): Record<string, number>;
  /** Note one metered call: who asked, which route, how it went. */
  note(call: MeteredCall): void;
  /** The day's noted calls (UTC `YYYY-MM-DD`, today when absent), oldest first. */
  calls(day?: string): MeteredCall[];
}

/** One metered call. `route` is the template (`GET /in/{vanity}`), never the path a person's name is in. */
export interface MeteredCall {
  at: string;
  site: string;
  account: string;
  route: string;
  use: Record<string, number>;
  /** Whoever the caller said it is (`x-caller`, or the request's `caller`); null when it said nothing. */
  caller: string | null;
  /** The Restate invocation, so the caller's own target can be looked up there. */
  invocation?: string;
  /** `capped` and `paced` spent nothing; `failed` got no answer. */
  outcome: "ok" | "failed" | "capped" | "paced";
  /** A failed call: whether it reached the site, so it spent a try. */
  spent?: boolean;
  /** The full bucket, when capped. */
  bucket?: string;
}

const KEEP_DAYS = 14;

/**
 * Default tries over a cap: a quarter for acts (refused follows in a row are a flag of their
 * own), half for reads.
 */
export const RETRY_BUFFER = { act: 0.25, read: 0.5 } as const;

interface Day {
  day: string;
  used: Record<string, number>;
  /** Absent in a file from before 2026-10-29: `used` then. */
  tried?: Record<string, number>;
  /** The earliest next call per `site|account`, epoch ms; it outlives the day. */
  next?: Record<string, number>;
}

const MAX_WAIT_MS = 120_000;

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const untilTomorrow = (t: number) => {
  const d = new Date(t);
  return Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - t) / 1000);
};

interface CallLog {
  add(day: string, call: MeteredCall): void;
  read(day: string): MeteredCall[];
}

function capsOn(
  load: () => Day | null,
  save: (d: Day) => void,
  log: CallLog,
  now: () => number,
  random: () => number,
): DailyCaps {
  const current = (): Day => {
    const d = load();
    const day = dayOf(now());
    if (d && d.day === day) return d;
    return { day, used: {}, ...(d?.next ? { next: d.next } : {}) };
  };
  const keyOf = (site: string, account: string, b: string) =>
    `${site}|${account.trim().toLowerCase()}|${b}`;
  const triedOf = (d: Day) => d.tried ?? { ...d.used };
  return {
    take(site, account, use, caps, buffer = 0) {
      const d = current();
      const tried = triedOf(d);
      const key = (b: string) => keyOf(site, account, b);
      for (const [bucket, n] of Object.entries(use)) {
        const cap = caps[bucket];
        if (cap === undefined) continue;
        const used = d.used[key(bucket)] ?? 0;
        const retryAfter = untilTomorrow(now());
        if (used + n > cap) return { ok: false, bucket, used, cap, retryAfter };
        // at least one spare try on any cap above 0
        const ceiling = cap + (cap > 0 && buffer > 0 ? Math.max(1, Math.ceil(cap * buffer)) : 0);
        const t = tried[key(bucket)] ?? 0;
        if (t + n > ceiling)
          return { ok: false, bucket, used: t, cap: ceiling, tries: true, retryAfter };
      }
      for (const [bucket, n] of Object.entries(use)) {
        d.used[key(bucket)] = (d.used[key(bucket)] ?? 0) + n;
        tried[key(bucket)] = (tried[key(bucket)] ?? 0) + n;
      }
      d.tried = tried;
      save(d);
      return { ok: true };
    },
    giveBack(site, account, use, reached = false) {
      const d = current();
      const tried = triedOf(d);
      const key = (b: string) => keyOf(site, account, b);
      for (const [bucket, n] of Object.entries(use)) {
        d.used[key(bucket)] = Math.max(0, (d.used[key(bucket)] ?? 0) - n);
        if (!reached) tried[key(bucket)] = Math.max(0, (tried[key(bucket)] ?? 0) - n);
      }
      d.tried = tried;
      save(d);
    },
    slot(site, account, pace) {
      const d = current();
      const key = `${site}|${account.trim().toLowerCase()}`;
      const t = now();
      const at = Math.max(t, d.next?.[key] ?? 0);
      const waitMs = at - t;
      if (waitMs > (pace.maxWaitMs ?? MAX_WAIT_MS))
        return { ok: false, waitMs, retryAfter: Math.ceil(waitMs / 1000) };
      const gap = pace.gapMs + Math.round(random() * (pace.jitterMs ?? 0));
      d.next = { ...d.next, [key]: at + gap };
      save(d);
      return { ok: true, waitMs };
    },
    today: () => current().used,
    tried: () => triedOf(current()),
    note: (call) => log.add(call.at.slice(0, 10), call),
    calls: (day) => log.read(day ?? dayOf(now())),
  };
}

/** A file per day under `dir`; a new day's first note drops files older than two weeks. */
function fileLog(dir: string, now: () => number): CallLog {
  let made = "";
  return {
    add(day, call) {
      if (made !== day) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const oldest = dayOf(now() - KEEP_DAYS * 86_400_000);
        for (const f of readdirSync(dir))
          if (f.endsWith(".jsonl") && f.slice(0, 10) < oldest)
            rmSync(join(dir, f), { force: true });
        made = day;
      }
      appendFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify(call)}\n`, { mode: 0o600 });
    },
    read(day) {
      let text = "";
      try {
        text = readFileSync(join(dir, `${day}.jsonl`), "utf8");
      } catch {
        return [];
      }
      const rows: MeteredCall[] = [];
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          rows.push(JSON.parse(line) as MeteredCall);
        } catch {
          // A torn last line from a crash: the rest still reads.
        }
      }
      return rows;
    },
  };
}

function memoryLog(): CallLog {
  const days = new Map<string, MeteredCall[]>();
  return {
    add: (day, call) => days.set(day, [...(days.get(day) ?? []), call]),
    read: (day) => days.get(day) ?? [],
  };
}

/** Kept in a file, so a restart (or a redeploy, with the file on the volume) never resets a day. */
export function fileCaps(
  path: string,
  now: () => number = Date.now,
  random: () => number = Math.random,
): DailyCaps {
  return capsOn(
    () => {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as Day;
      } catch {
        return null;
      }
    },
    (d) => {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(d)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    },
    fileLog(join(dirname(path), "caps-calls"), now),
    now,
    random,
  );
}

export function memoryCaps(
  now: () => number = Date.now,
  random: () => number = Math.random,
): DailyCaps {
  let kept: Day | null = null;
  return capsOn(
    () => kept,
    (d) => {
      kept = d;
    },
    memoryLog(),
    now,
    random,
  );
}
