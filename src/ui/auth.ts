/**
 * One bearer for the UI and inbound hooks. Unset means local use with no
 * auth, and the server then refuses to listen on anything but loopback.
 * Comparison is constant-time; the token never appears in a log or URL.
 */
import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

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
