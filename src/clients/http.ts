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
  /** Raw body, already encoded; sets no content type (set one in `headers`). */
  raw?: string | Uint8Array<ArrayBuffer>;
}

export interface JsonResponse<T> {
  status: number;
  ok: boolean;
  /** Parsed JSON, or null when the body is empty or not JSON. */
  body: T | null;
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
            ? { body: req.raw }
            : {}),
      };
      for (let attempt = 1; ; attempt += 1) {
        const last = attempt === attempts;
        let response: Response;
        try {
          response = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
          // Connection refused, DNS, or our own timeout: the request may not have left.
          if (last || !retryOnServer) throw new HttpError(method, url, 0, describe(err));
          await sleep(backoff(attempt, null, random));
          continue;
        }
        const retry =
          RETRY_STATUSES.has(response.status) && (retryOnServer || response.status === 429);
        if (!retry || last) {
          const text = await response.text();
          return {
            status: response.status,
            ok: response.ok,
            body: parseJson<T>(text),
            headers: response.headers,
          };
        }
        await response.body?.cancel().catch(() => undefined);
        await sleep(backoff(attempt, response.headers.get("retry-after"), random));
      }
    },
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

/** Retry-After (seconds) when given; else exponential with full jitter, capped. */
export function backoff(attempt: number, retryAfter: string | null, random = Math.random): number {
  const hinted = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(hinted) && hinted >= 0) return Math.min(hinted * 1000, MAX_BACKOFF_MS);
  const ceiling = Math.min(500 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return Math.floor(random() * ceiling);
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.name === "TimeoutError" ? "timeout" : err.name;
  return "network error";
}
