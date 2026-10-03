/**
 * One bearer for the UI and inbound hooks. Unset means local use with no
 * auth, and the server then refuses to listen on anything but loopback.
 * Comparison is constant-time; the token never appears in a log or URL.
 */
import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { type KeyStore, OPERATOR, type Scope } from "../access/keys.js";
import { fail } from "./http.js";

export function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearerAuth(token: string | undefined): MiddlewareHandler {
  return async (c, next) => {
    if (token === undefined) return next();
    const header = c.req.header("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!tokenMatches(given, token))
      return fail(c, 401, "unauthorized: send Authorization: Bearer <token>");
    return next();
  };
}

/**
 * Who is asking: the operator (the token, or local use with no token and no
 * bearer) or an agent by its key (`access/keys`). A bearer that is neither
 * is refused, local or not: a wrong key never falls through to the operator.
 */
export function accessAuth(
  token: string | undefined,
  keys: KeyStore | null | undefined,
): MiddlewareHandler<{ Variables: { scope: Scope } }> {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : undefined;
    const scope =
      given === undefined
        ? token === undefined
          ? OPERATOR
          : null
        : token !== undefined && tokenMatches(given, token)
          ? OPERATOR
          : (keys?.resolve(given) ?? null);
    if (!scope) return fail(c, 401, "unauthorized: send Authorization: Bearer <token>");
    c.set("scope", scope);
    return next();
  };
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * A web page the person happens to open must not drive the worker: a
 * browser sends any site's POST to 127.0.0.1 and names the page in
 * `Origin`. Refused unless the origin is ours (the same host) or loopback
 * (the dev server). Without a token, the Host must be loopback too: a
 * name that resolves to 127.0.0.1 (DNS rebinding) is someone else's page.
 */
export function originGuard(token: string | undefined): MiddlewareHandler {
  return async (c, next) => {
    // Every browser sends Host; a request without one is no web page's.
    const host = c.req.header("host") ?? "";
    if (token === undefined && host && !LOOPBACK.test(host))
      return fail(c, 403, "local use answers loopback only");
    const origin = c.req.header("origin");
    if (origin) {
      let from = "";
      try {
        from = new URL(origin).host;
      } catch {}
      if (from !== host && !LOOPBACK.test(from)) return fail(c, 403, "cross-site request refused");
    }
    return next();
  };
}

export interface RateLimitOptions {
  perMinute: number;
  /** Who a request counts against; default the first `x-forwarded-for` hop, else `local`. */
  keyOf?: (c: Context) => string;
  now?: () => number;
}

/**
 * Fixed-window limiter, one window per caller per minute. Every answer says
 * where the caller stands (`RateLimit-Limit`, `-Remaining`, `-Reset` in
 * seconds); a refusal is 429 `rate_limited` with `Retry-After`. Expired
 * windows are swept, so a flood of new callers never resets the others.
 */
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const now = opts.now ?? Date.now;
  const keyOf =
    opts.keyOf ??
    ((c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local");
  const windows = new Map<string, { start: number; count: number }>();
  return async (c, next) => {
    const key = keyOf(c);
    const t = now();
    let w = windows.get(key);
    if (!w || t - w.start >= 60_000) {
      if (windows.size >= 10_000)
        for (const [k, old] of windows) if (t - old.start >= 60_000) windows.delete(k);
      w = { start: t, count: 0 };
      windows.set(key, w);
    }
    w.count++;
    const reset = Math.max(1, Math.ceil((w.start + 60_000 - t) / 1000));
    c.header("RateLimit-Limit", String(opts.perMinute));
    c.header("RateLimit-Remaining", String(Math.max(0, opts.perMinute - w.count)));
    c.header("RateLimit-Reset", String(reset));
    if (w.count > opts.perMinute) {
      c.header("Retry-After", String(reset));
      return fail(c, 429, `rate limited: ${opts.perMinute} a minute, try again in ${reset}s`, {
        retryAfter: reset,
      });
    }
    return next();
  };
}
