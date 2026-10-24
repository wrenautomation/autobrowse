/**
 * One HTTP door for every client: a timeout, bounded retries on the answers
 * that mean "try again", JSON in and out. Bearers travel in headers only.
 * An error carries method, host+path and status, never a header or body.
 *
 * Retry policy, chosen per method because a retried write can double up:
 * - GET/PUT/DELETE/PATCH are idempotent by contract: retried on 429, 5xx,
 *   timeouts and connection errors.
 * - POST is retried only on 429 (the server refused it, so it did not run).
 *   A POST that timed out may have run; the caller's step is idempotent
 *   (get before create) and simply reruns.
 * - A stream body is never retried: once read it is gone.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetch?: FetchLike;
  /** Per attempt. */
  timeoutMs?: number;
  /** Attempts in total, including the first. */
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /** For tests: deterministic backoff. */
  random?: () => number;
}

export interface JsonRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  /** JSON-encoded when present. */
  body?: unknown;
  /** Raw body, already encoded; sets no content type (set one in `headers`). A stream is sent once. */
  raw?: string | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>;
  /** This call's own per-attempt timeout (a large upload), over the client's. */
  timeoutMs?: number;
}

export interface JsonResponse<T> {
  status: number;
  ok: boolean;
  /** Parsed JSON, or null when the body is empty or not JSON. */
  body: T | null;
  /** The body as sent, for the few answers that are text (a Drive export). */
  text?: string;
  headers: Headers;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(method: string, url: string, status: number, note = "") {
    super(`${method} ${safeUrl(url)}: HTTP ${status}${note ? ` ${note}` : ""}`);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * The body of an answer that was ok; a failed one becomes the HttpError. `why` reads the
 * site's own words off the body (a code, a reason), never a token: it is the note in the message.
 */
export function mustOk<T>(
  res: Pick<JsonResponse<T>, "ok" | "status" | "body">,
  url: string,
  why: (body: unknown) => string = () => "",
): T {
  if (!res.ok) throw new HttpError("CALL", url, res.status, why(res.body));
  return res.body as T;
}

/** A platform's 4xx that waiting won't change (402 out of credit, 403 refused); 408 and 429 heal. */
export const lastingRefusal = (err: unknown): err is HttpError =>
  err instanceof HttpError &&
  err.status >= 400 &&
  err.status < 500 &&
  err.status !== 408 &&
  err.status !== 429;

export interface HttpClient {
  json<T>(url: string, req?: JsonRequest): Promise<JsonResponse<T>>;
}

const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const MAX_BACKOFF_MS = 10_000;

/** Origin + path only: query strings can carry tokens. */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<url>";
  }
}

/** Every URL in a message down to origin + path: an error names the page, never its tokens. */
export function safeUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>)]*[^\s"'<>).,;:!?]/gi, safeUrl);
}

export function httpClient(opts: HttpOptions = {}): HttpClient {
  const doFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const attempts = Math.max(1, opts.attempts ?? 3);
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;

  return {
    async json<T>(url: string, req: JsonRequest = {}): Promise<JsonResponse<T>> {
      const method = req.method ?? "GET";
      const retryOnServer = method !== "POST";
      const stream = req.raw instanceof ReadableStream;
      const tries = stream ? 1 : attempts;
      const wait = req.timeoutMs ?? timeoutMs;
      const init: RequestInit = {
        method,
        headers: {
          accept: "application/json",
          ...(req.body === undefined ? {} : { "content-type": "application/json" }),
          ...(req.headers ?? {}),
        },
        ...(req.body !== undefined
          ? { body: JSON.stringify(req.body) }
          : req.raw !== undefined
            ? { body: req.raw, ...(stream ? { duplex: "half" } : {}) }
            : {}),
      };
      for (let attempt = 1; ; attempt += 1) {
        const last = attempt === tries;
        let response: Response;
        try {
          response = await doFetch(url, { ...init, signal: AbortSignal.timeout(wait) });
        } catch (err) {
          // Connection refused, DNS, or our own timeout: the request may not have left.
          if (last || !retryOnServer) throw new HttpError(method, url, 0, describe(err));
          await sleep(backoff(attempt, null, random));
          continue;
        }
        // A Retry-After past what we wait is the server saying "not yet": asking again after our
        // cap would be a call it refuses, so the answer goes back to the caller as it is.
        const named = hintOf(response.headers.get("retry-after"));
        const retry =
          RETRY_STATUSES.has(response.status) &&
          (retryOnServer || response.status === 429) &&
          (named === null || named <= MAX_BACKOFF_MS);
        if (!retry || last) {
          let text: string;
          try {
            text = await response.text();
          } catch (err) {
            // The timeout covers the body too: an answer that stalls mid-body is no answer, and a
            // bare "The operation was aborted due to timeout" named no call (meta's Instagram
            // lookups, 2026-10-15). Asked again like a dropped connection.
            if (last || !retryOnServer) throw new HttpError(method, url, 0, describe(err));
            await sleep(backoff(attempt, null, random));
            continue;
          }
          return {
            status: response.status,
            ok: response.ok,
            body: parseJson<T>(text),
            text,
            headers: response.headers,
          };
        }
        await response.body?.cancel().catch(() => undefined);
        await sleep(backoff(attempt, response.headers.get("retry-after"), random));
      }
    },
  };
}

/**
 * A `FetchLike` over an `HttpClient`, for a piece that takes `fetch` and keeps no policy of its own:
 * the client's timeout and retries apply. A connection failure is an `HttpError`, not a `TypeError`.
 */
export function fetchOf(http: HttpClient): FetchLike {
  return async (url, init) => {
    const body = init?.body;
    const res = await http.json<unknown>(url, {
      method: (init?.method ?? "GET") as NonNullable<JsonRequest["method"]>,
      headers: Object.fromEntries(new Headers(init?.headers)),
      ...(typeof body === "string" ? { raw: body } : {}),
    });
    const empty = res.status === 204 || res.status === 205 || res.status === 304;
    return new Response(empty ? null : (res.text ?? ""), {
      status: res.status,
      headers: res.headers,
    });
  };
}

function parseJson<T>(text: string): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** The wait a Retry-After header names, in ms; null when absent or not a number of seconds. */
function hintOf(retryAfter: string | null): number | null {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/** Retry-After (seconds) when given; else exponential with full jitter, capped. */
export function backoff(attempt: number, retryAfter: string | null, random = Math.random): number {
  const hinted = hintOf(retryAfter);
  if (hinted !== null) return Math.min(hinted, MAX_BACKOFF_MS);
  const ceiling = Math.min(500 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return Math.floor(random() * ceiling);
}

function describe(err: unknown): string {
  if (!(err instanceof Error)) return "network error";
  if (err.name === "TimeoutError") return "timeout";
  // Node's fetch says only "TypeError: fetch failed"; the reason (ECONNRESET, a socket closed) is its cause.
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const why = cause?.code ?? cause?.message?.split("\n")[0]?.slice(0, 80);
  return why ? `${err.name} (${why})` : err.name;
}
