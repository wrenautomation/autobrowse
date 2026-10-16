/**
 * Send verdicts (designs/2026-10-16-send-verdicts.md): whether an irreversible write went out,
 * typed, per send key. A keyed write answers a `SendVerdict` as its result, never words in an
 * error. An unclear end is settled by the route's `verify` read: the account's own recent
 * objects, matched here by words and time. One matcher for every site; no per-site copies.
 */

/** What a keyed write answers. */
export type SendVerdict =
  | {
      verdict: "sent";
      /** The platform's id and link for what went out, when known. */
      id: string | null;
      url: string | null;
      /** When it went out (the answer's time, the row's time, or when the call ended). */
      at: string;
      /** `answer`: the platform answered with it. `verified`: the verify read found it. */
      how: "answer" | "verified";
      /** The official answer, as an unkeyed call answers it; only when `how` is `answer`. */
      output?: unknown;
    }
  | {
      verdict: "not_sent";
      reason: string;
      /**
       * `refused`: the platform said no to the write. `before_submit`: it failed before the
       * submit step started. `verified_absent`: a full verify read found nothing.
       */
      how: "refused" | "before_submit" | "verified_absent";
      /** The platform's HTTP status, on a refusal. */
      status?: number;
    }
  | {
      verdict: "unknown";
      reason: string;
      /** When the send started. */
      since: string;
    };

export type Verdict = SendVerdict["verdict"];

/** A final verdict is never asked again: a repeat of its key answers it and writes nothing. */
export const isFinal = (v: SendVerdict): boolean => v.verdict !== "unknown";

/** One of the account's own recent objects, as a verify read shows it. */
export interface VerifyRow {
  /** Its text, or the preview of it a list shows. */
  words: string;
  /** When it was made, ISO; null when the read does not say. */
  at: string | null;
  id: string | null;
  url: string | null;
  /** False: someone else's (a thread's comments list shows everyone's). Absent: ours. */
  mine?: boolean;
}

/** What a verify read covers. */
export interface VerifyRead {
  rows: readonly VerifyRow[];
  /**
   * `newest`: newest first by time, so a row older than the send means nothing newer was cut.
   * `ranked`: some other order (Instagram ranks comments): only `complete` proves absent.
   */
  order: "newest" | "ranked";
  /** The read holds every object it could (not cut at a limit, not a first page). */
  complete: boolean;
}

/** What a verify read says about the send. */
export type Seen =
  | { seen: "found"; id: string | null; url: string | null; at: string | null }
  | { seen: "absent" }
  | { seen: "unclear"; why: string };

/** A GET on this site as the sending account (`site`: another one, such as `reddit-public`). */
export type VerifyGet = (
  path: string,
  input?: Record<string, unknown>,
  site?: string,
) => Promise<unknown>;

/** How an irreversible route proves what happened after an unclear end. */
export interface RouteVerify<I = never> {
  /** Our words as sent: what a row must show. Empty: the read decides (a connect has no words). */
  words: (input: I) => string;
  /**
   * Read the account's own recent objects through `get`. Rows go through `matchSent`; a route
   * whose answer is not words (a connect's state) answers a `Seen` itself.
   */
  read: (input: I, get: VerifyGet) => Promise<VerifyRead | Seen>;
  /** Why this list shows a fresh object late (a TikTok video until processed): then absent is unclear. */
  lags?: (input: I) => string | null;
}

/** An irreversible route with no read that can prove it: its unclear end is `unknown`, said why. */
export interface NoVerify {
  none: string;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
};

/** Words as a site may echo them: entities decoded, Markdown escapes and spacing dropped. */
export const wordsOf = (text: string): string =>
  text
    .replace(/&(?:amp|lt|gt|quot|nbsp|#39|#x27);/g, (e) => ENTITIES[e] ?? e)
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** Long enough that a prefix match is these words, not a common opener. */
const PREFIX_MIN = 40;
const PREFIX_MAX = 120;

/**
 * Are these the words we sent? Equal once normalized, or one a cut of the other (a preview, a
 * site's trim) over enough of it to be ours.
 */
export function sameWords(theirs: string, ours: string): boolean {
  const b = wordsOf(ours);
  const whole = wordsOf(theirs);
  if (!whole || !b) return false;
  if (whole === b) return true;
  // A list's preview ends its cut with an ellipsis: the words before it are the site's.
  const a = whole.replace(/\s*(…|\.\.\.)$/, "");
  const n = Math.min(a.length, b.length, PREFIX_MAX);
  if (n < Math.min(PREFIX_MIN, b.length)) return false;
  return a.slice(0, n) === b.slice(0, n);
}

/** Leeway for a site clock that runs behind ours. */
export const CLOCK_SLACK_MS = 5 * 60_000;

/**
 * Our words in a verify read. Found: a row of ours, made since the send started (less the clock
 * slack, or with no time), shows them. Absent: no such row, and the read is complete or reaches
 * back past the send in time order. Else unclear: never a guess.
 */
export function matchSent(read: VerifyRead, o: { words: string; since: string }): Seen {
  const floor = new Date(o.since).getTime() - CLOCK_SLACK_MS;
  const ours = read.rows.filter((r) => r.mine !== false);
  const recent = (r: VerifyRow) => r.at === null || new Date(r.at).getTime() >= floor;
  const hit = ours.find((r) => recent(r) && (o.words ? sameWords(r.words, o.words) : true));
  if (hit) return { seen: "found", id: hit.id, url: hit.url, at: hit.at };
  if (read.complete) return { seen: "absent" };
  if (read.order === "ranked")
    return { seen: "unclear", why: "a ranked list, not read to its end" };
  const oldest = read.rows.at(-1)?.at;
  if (oldest && new Date(oldest).getTime() < floor) return { seen: "absent" };
  return { seen: "unclear", why: "the list does not reach back to the send" };
}

/** A read's answer, settled: rows matched, and a lagging list never proves absent. */
export function settle(
  got: VerifyRead | Seen,
  o: { words: string; since: string; lags?: string | null },
): Seen {
  const s = "seen" in got ? got : matchSent(got, o);
  return s.seen === "absent" && o.lags ? { seen: "unclear", why: o.lags } : s;
}
