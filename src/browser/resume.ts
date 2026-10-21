/**
 * Where a durable call stopped, so its next try starts there and not at step
 * 1 (designs/2026-10-20-batched-plans-and-resume.md). A flow function cannot
 * start at its line N, but a walk finds its screen by looking at the page:
 * open the page the last try stopped on, and the walk goes on from there.
 *
 * One small file per call key (`withCall`) that ended without success: the
 * main page's URL, the profile, the screens each walk got past, when. Never
 * input values or page text. Cleared on success, aged out after 7 days.
 */
import { readFileSync, rmSync } from "node:fs";
import { callFile, KEEP_MS, writeCallFile } from "./attempt.js";

export interface ResumeRecord {
  /** The main page when the try stopped: origin and path, query keys only as `keptUrl` allows. */
  url: string;
  /** The profile it ran on: another profile's page is not this call's. */
  profile: string;
  /** Screens each walk got past, by `<site>/<walk>`, in order. */
  screensDone: Record<string, string[]>;
  at: number;
}

export interface Resumes {
  /** The call's record, or null (none, or older than 7 days). */
  get(call: string): ResumeRecord | null;
  put(call: string, r: ResumeRecord): void;
  clear(call: string): void;
}

export function fileResumes(dir: string, now: () => number = Date.now): Resumes {
  return {
    get(call) {
      try {
        const got = JSON.parse(readFileSync(callFile(dir, call), "utf8")) as ResumeRecord;
        return now() - got.at < KEEP_MS ? got : null;
      } catch {
        return null;
      }
    },
    put(call, r) {
      try {
        writeCallFile(dir, call, r, now);
      } catch {
        // A full disk never fails the run; the next try starts at step 1.
      }
    },
    clear: (call) => rmSync(callFile(dir, call), { force: true }),
  };
}

export function memoryResumes(): Resumes & { rows: Map<string, ResumeRecord> } {
  const rows = new Map<string, ResumeRecord>();
  return {
    rows,
    get: (call) => rows.get(call) ?? null,
    put: (call, r) => void rows.set(call, r),
    clear: (call) => void rows.delete(call),
  };
}

/**
 * The URL to keep for `page`: origin and path. A query string can carry a token the site
 * minted mid-flow (a magic link, an OAuth code), so its keys are kept only when the run's
 * first URL on the same origin carried them too: the caller chose those (`?gh_jid=`).
 * Null for a page that is not on the web (about:blank, Chrome's error page).
 */
export function keptUrl(page: string, first: string | null): string | null {
  let u: URL;
  try {
    u = new URL(page);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const out = new URL(`${u.origin}${u.pathname}`);
  const given = first && URL.canParse(first) ? new URL(first) : null;
  if (given?.origin === u.origin)
    for (const [k, v] of u.searchParams)
      if (given.searchParams.has(k)) out.searchParams.append(k, v);
  return out.toString();
}

/** Same host: a saved page stands in for the first open only on its own site. */
export function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}
