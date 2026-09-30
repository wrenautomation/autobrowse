/**
 * One bearer for the UI and inbound hooks. Unset means local use with no
 * auth, and the server then refuses to listen on anything but loopback.
 * Comparison is constant-time; the token never appears in a log or URL.
 */
import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { type KeyStore, OPERATOR, type Scope } from "../access/keys.js";

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
    if (!tokenMatches(given, token)) return c.json({ error: "unauthorized" }, 401);
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
    if (!scope) return c.json({ error: "unauthorized" }, 401);
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
      return c.json({ error: "local use answers loopback only" }, 403);
    const origin = c.req.header("origin");
    if (origin) {
      let from = "";
      try {
        from = new URL(origin).host;
      } catch {}
      if (from !== host && !LOOPBACK.test(from))
        return c.json({ error: "cross-site request refused" }, 403);
    }
    return next();
  };
}

/** Fixed-window limiter per key, for the inbound hook: a text message is never a flood. */
export function rateLimit(opts: { perMinute: number; now?: () => number }): MiddlewareHandler {
  const now = opts.now ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();
  return async (c, next) => {
    const key = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    const t = now();
    const w = windows.get(key);
    if (!w || t - w.start >= 60_000) windows.set(key, { start: t, count: 1 });
    else if (++w.count > opts.perMinute) return c.json({ error: "rate limited" }, 429);
    if (windows.size > 10_000) windows.clear();
    return next();
  };
}
