/**
 * The API's one way to answer a mistake, read a body or a query, and page a
 * list. Every refusal is `{ error, code }`: `error` is the sentence a person
 * reads, `code` is what a program branches on (`ErrorCode`), `issues` lists
 * each bad field. Statuses follow HTTP: 400 bad input, 401 no key, 403 not
 * yours, 404 no such thing, 409 not now, 413 too big, 415 not JSON, 429 slow
 * down, 501 not set up on this worker, 502 the site behind it failed.
 */
import type { Context } from "hono";
import { z } from "zod";

export type ErrorCode =
  | "bad_request"
  | "invalid_json"
  | "invalid_body"
  | "invalid_query"
  | "invalid_path"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "payload_too_large"
  | "unsupported_media_type"
  | "rate_limited"
  | "internal"
  | "not_configured"
  | "upstream_error"
  | "unavailable";

const CODE_OF: Record<number, ErrorCode> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  429: "rate_limited",
  500: "internal",
  501: "not_configured",
  502: "upstream_error",
  503: "unavailable",
};

export interface Issue {
  /** Where in the input: `plan.domain`, `limit`; empty for the whole thing. */
  path: string;
  message: string;
}

export interface ErrorBody {
  error: string;
  code: ErrorCode;
  issues?: Issue[];
  [extra: string]: unknown;
}

/** The error body for `status`; its code is the status's own unless `extra.code` names a finer one. */
export function errorBody(
  status: number,
  message: string,
  extra: Partial<ErrorBody> = {},
): ErrorBody {
  return {
    error: message,
    code: CODE_OF[status] ?? (status >= 500 ? "internal" : "bad_request"),
    ...extra,
  };
}

export function fail(c: Context, status: number, message: string, extra: Partial<ErrorBody> = {}) {
  return c.json(errorBody(status, message, extra), status as 400);
}

export const issuesOf = (err: z.ZodError): Issue[] =>
  err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));

/** A 400 naming the first bad field in the sentence and every one in `issues`. */
export function invalid(
  c: Context,
  err: z.ZodError,
  code: "invalid_body" | "invalid_query" | "invalid_path" = "invalid_body",
) {
  const issues = issuesOf(err);
  const first = issues[0];
  const where = code === "invalid_query" ? "query" : code === "invalid_path" ? "path" : "body";
  const message = first ? `${first.path || where}: ${first.message}` : `bad ${where}`;
  return fail(c, 400, message, { code, issues });
}

type Read<T> = { ok: true; data: T } | { ok: false; res: Response };

/**
 * The JSON body checked against `schema`. No body reads as `{}` (actions
 * whose fields are all optional); a body must say it is JSON (415) and
 * parse (400 `invalid_json`) before the schema sees it (400 `invalid_body`).
 */
export async function readJson<S extends z.ZodTypeAny>(
  c: Context,
  schema: S,
): Promise<Read<z.output<S>>> {
  const text = await c.req.text();
  let value: unknown = {};
  if (text.trim()) {
    const type = c.req.header("content-type") ?? "";
    if (!/\bjson\b/i.test(type))
      return {
        ok: false,
        res: fail(c, 415, "send the body as application/json"),
      };
    try {
      value = JSON.parse(text);
    } catch {
      return { ok: false, res: fail(c, 400, "body is not valid JSON", { code: "invalid_json" }) };
    }
  }
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, res: invalid(c, parsed.error) };
}

/** The query string checked against `schema` (400 `invalid_query`). */
export function readQuery<S extends z.ZodTypeAny>(c: Context, schema: S): Read<z.output<S>> {
  const parsed = schema.safeParse(c.req.query());
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, res: invalid(c, parsed.error, "invalid_query") };
}

/** Path params checked against `schema` (400 `invalid_path`): a bad name never reaches a lookup. */
export function readPath<S extends z.ZodTypeAny>(c: Context, schema: S): Read<z.output<S>> {
  const parsed = schema.safeParse(c.req.param());
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, res: invalid(c, parsed.error, "invalid_path") };
}

/**
 * A page of a list: the rows, and when more follow, a `Link: <…>; rel="next"`
 * carrying the same query with the next cursor. The body stays the bare
 * array, so a client that only wants the first page reads it as before.
 */
export function page<T>(c: Context, rows: T[], next: string | null) {
  if (next !== null) {
    const url = new URL(c.req.url);
    url.searchParams.set("before", next);
    c.header("Link", `<${url.pathname}${url.search}>; rel="next"`);
  }
  return c.json(rows);
}

/** A list's `?limit=`: 1 to `max`, `fallback` when absent. */
export const limitParam = (fallback: number, max: number) =>
  z.coerce.number().int().min(1).max(max).default(fallback);

/** `?status=waiting,running` → the allowed words, each checked. */
export const csvOf = <T extends string>(words: readonly [T, ...T[]]) =>
  z
    .string()
    .transform((s) =>
      s
        .split(",")
        .map((w) => w.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(words)).min(1));
