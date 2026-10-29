/**
 * Tokens a platform refused (revoked, invalid_grant, a 401 on the who-am-I probe), kept by name
 * where `renew` reads them. A refused token is due at once, however far off its lapse date: renew
 * runs its setup step again, one try a day. Two failed days and it stops, with one notice saying
 * what a person must do; it is due again only once the token changes (a setup clears the row).
 * One row is one incident: the first refusal opens it and is said once, later calls add nothing.
 * Names, sites, dates and the site's words only; never a value.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Days a refused token is tried again before it waits for a person. */
export const GIVE_UP_DAYS = 2;

export interface RefusedToken {
  /** The kept name the site refused (the real copy when an alias pointed at it). */
  name: string;
  site: string;
  /** The account the call ran as; null = the site's own name. */
  account: string | null;
  /** When it was first refused (ISO). */
  since: string;
  /** What the site said. */
  words: string;
  /** `tokenMark` of the refused value: calls with it are held, a new value goes through. */
  held?: string;
  /** Days (yyyy-mm-dd, UTC) a re-make started; a try that never ended still counts. */
  tries: string[];
  /** The last failed try's words. */
  error?: string;
  /** When renew stopped trying (ISO): the person's turn. */
  gaveUp?: string;
  /** A re-make was queued for this incident (the desk sends one, once). */
  queued?: boolean;
}

export interface RefusedTokens {
  list(): RefusedToken[];
  /** Record a refusal; `fresh` when it opens an incident, so its notice is sent once. */
  refuse(
    r: Pick<RefusedToken, "name" | "site" | "account" | "words" | "held">,
    now: Date,
  ): { fresh: boolean; row: RefusedToken };
  /** Rows no re-make was queued or tried for yet, now marked queued: each incident once. */
  claim(): RefusedToken[];
  /** A re-make of `name` starts today. */
  start(name: string, now: Date): void;
  /**
   * A re-make of `name` ended. Ok drops the row. A busy profile reached no site, so the day is
   * not spent. Otherwise, at `GIVE_UP_DAYS` tries it gives up: `gaveUp` is true that once.
   */
  end(
    name: string,
    r: { ok: boolean; error?: string; busy?: boolean },
    now: Date,
  ): { gaveUp: boolean };
  /** Rows whose last try never ended and whose days are used: given up now, each returned once. */
  stale(now: Date): RefusedToken[];
  /** These names were made again or answered: their rows go. */
  clear(names: readonly string[]): RefusedToken[];
}

/** A short hash of a token value: names which value was refused, never the value. */
export const tokenMark = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

export const dayOf = (now: Date) => now.toISOString().slice(0, 10);

/** Due a re-make today: not given up, not tried today, days left. */
export function dueToday(rows: readonly RefusedToken[], now: Date): RefusedToken[] {
  const today = dayOf(now);
  return rows.filter((r) => !r.gaveUp && !r.tries.includes(today) && r.tries.length < GIVE_UP_DAYS);
}

/** The store over any load/save pair: one copy of the rules. */
function refusedTokens(io: {
  load(): RefusedToken[];
  save(rows: RefusedToken[]): void;
}): RefusedTokens {
  const change = <T>(fn: (rows: RefusedToken[]) => T): T => {
    const rows = io.load();
    const out = fn(rows);
    io.save(rows);
    return out;
  };
  return {
    list: () => io.load(),
    refuse: (r, now) =>
      change((rows) => {
        const had = rows.find((x) => x.name === r.name);
        if (had) {
          if (r.held) had.held = r.held;
          return { fresh: false, row: had };
        }
        const row: RefusedToken = { ...r, since: now.toISOString(), tries: [] };
        rows.push(row);
        return { fresh: true, row };
      }),
    claim: () =>
      change((rows) => {
        const out = rows.filter((r) => !r.queued && !r.tries.length && !r.gaveUp);
        for (const r of out) r.queued = true;
        return out.map((r) => ({ ...r }));
      }),
    start: (name, now) =>
      change((rows) => {
        const r = rows.find((x) => x.name === name);
        if (r && !r.tries.includes(dayOf(now))) r.tries.push(dayOf(now));
      }),
    end: (name, res, now) =>
      change((rows) => {
        const i = rows.findIndex((x) => x.name === name);
        const r = rows[i];
        if (!r) return { gaveUp: false };
        if (res.ok) {
          rows.splice(i, 1);
          return { gaveUp: false };
        }
        if (res.busy) {
          r.tries = r.tries.filter((d) => d !== dayOf(now));
          return { gaveUp: false };
        }
        if (res.error) r.error = res.error;
        if (r.tries.length < GIVE_UP_DAYS || r.gaveUp) return { gaveUp: false };
        r.gaveUp = now.toISOString();
        return { gaveUp: true };
      }),
    stale: (now) =>
      change((rows) => {
        const out = rows.filter(
          (r) => !r.gaveUp && r.tries.length >= GIVE_UP_DAYS && !r.tries.includes(dayOf(now)),
        );
        for (const r of out) r.gaveUp = now.toISOString();
        return out.map((r) => ({ ...r }));
      }),
    clear: (names) =>
      change((rows) => {
        const gone = rows.filter((r) => names.includes(r.name));
        for (const r of gone) rows.splice(rows.indexOf(r), 1);
        return gone;
      }),
  };
}

export function memoryRefusedTokens(): RefusedTokens {
  let held: RefusedToken[] = [];
  return refusedTokens({
    load: () => structuredClone(held),
    save: (rows) => {
      held = structuredClone(rows);
    },
  });
}

/** Rows in a JSON file, read per op so the desk and the CLI on one Mac agree. */
export function fileRefusedTokens(path: string): RefusedTokens {
  return refusedTokens({
    load: () => {
      try {
        return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RefusedToken[]) : [];
      } catch {
        return [];
      }
    },
    save: (rows) => {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    },
  });
}

/** `2026-10-15T14:02:11Z` → `2026-10-15 14:02 UTC`. */
export const utcOf = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/** `will@wren.com` → `w***@wren.com`: an account named in a channel without spelling it out. */
export const maskAccount = (a: string | null) => (a ? a.replace(/^(.)[^@]*@/, "$1***@") : null);

/** One plain line for a row: what, since when, where it stands. */
export function refusedLine(r: RefusedToken): string {
  const as = r.account ? ` as ${maskAccount(r.account)}` : "";
  const why = r.error ? ` (${r.error})` : "";
  const state = r.gaveUp
    ? `gave up ${utcOf(r.gaveUp)} after ${r.tries.length} days${why}: needs a person`
    : r.tries.length
      ? `re-make tried ${r.tries.length} day${r.tries.length === 1 ? "" : "s"}${why}`
      : "re-make queued";
  return `${r.name} (${r.site}${as}) refused since ${utcOf(r.since)}: ${r.words}; ${state}`;
}
