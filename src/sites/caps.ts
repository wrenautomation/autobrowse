/**
 * Daily caps on a site's reads, per account: LinkedIn lets a person look at
 * so many profiles a day before it restricts the account, and one account's
 * reads never spend another's. A call takes all its buckets or none; over a
 * cap it is refused with the seconds until the day turns (UTC), never queued.
 *
 * Pace: a person does not open ten profiles in ten seconds. A paced site
 * books each call a slot at least `gapMs` (plus up to `jitterMs`, random)
 * after the last one for that account; the caller sleeps until it. A slot
 * further out than `maxWaitMs` is refused like a cap, with its seconds.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Taken {
  ok: boolean;
  /** The bucket that was full, when refused. */
  bucket?: string;
  used?: number;
  cap?: number;
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
  take(
    site: string,
    account: string,
    use: Record<string, number>,
    caps: Record<string, number>,
  ): Taken;
  /** Book the next slot for `site|account` under `pace`; nothing is booked when refused. */
  slot(site: string, account: string, pace: Pace): Slot;
  /** What each bucket has used today, by `site|account|bucket`. */
  today(): Record<string, number>;
}

interface Day {
  day: string;
  used: Record<string, number>;
  /** The earliest next call per `site|account`, epoch ms; it outlives the day. */
  next?: Record<string, number>;
}

const MAX_WAIT_MS = 120_000;

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const untilTomorrow = (t: number) => {
  const d = new Date(t);
  return Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - t) / 1000);
};

function capsOn(
  load: () => Day | null,
  save: (d: Day) => void,
  now: () => number,
  random: () => number,
): DailyCaps {
  const current = (): Day => {
    const d = load();
    const day = dayOf(now());
    if (d && d.day === day) return d;
    return { day, used: {}, ...(d?.next ? { next: d.next } : {}) };
  };
  return {
    take(site, account, use, caps) {
      const d = current();
      const key = (b: string) => `${site}|${account.trim().toLowerCase()}|${b}`;
      for (const [bucket, n] of Object.entries(use)) {
        const cap = caps[bucket];
        const used = d.used[key(bucket)] ?? 0;
        if (cap !== undefined && used + n > cap)
          return { ok: false, bucket, used, cap, retryAfter: untilTomorrow(now()) };
      }
      for (const [bucket, n] of Object.entries(use))
        d.used[key(bucket)] = (d.used[key(bucket)] ?? 0) + n;
      save(d);
      return { ok: true };
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
    now,
    random,
  );
}
