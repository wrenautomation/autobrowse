/**
 * Session-only cookies a sign-in leaves, kept across browser restarts. LinkedIn
 * signed in through Google sets `li_at` with no expiry (mapped 2026-10-05):
 * Chrome drops it on exit, so every new browser met /authwall and signed in to
 * Google again, where a second step can ask for William's phone. On close each
 * one gets an expiry, as Chrome's own "continue where you left off" keeps them
 * for a person. Per site: a site that means "until the browser closes" keeps
 * that unless it is listed here.
 */
import type { BrowserContext } from "playwright";

/** Site (before any `@label`) → the cookie domains kept. */
const KEEP: Record<string, RegExp> = {
  linkedin: /(^|\.)linkedin\.com$/,
};

/** Re-kept on every close, so a used profile never runs out. */
const KEEP_DAYS = 30;

export function keptDomains(site: string): RegExp | null {
  return KEEP[site.split("@")[0] ?? site] ?? null;
}

/** Give the session-only cookies on `domains` an expiry; returns how many. */
export async function keepSessionCookies(
  context: Pick<BrowserContext, "cookies" | "addCookies">,
  domains: RegExp,
  now = Date.now(),
): Promise<number> {
  const expires = Math.floor(now / 1000) + KEEP_DAYS * 86_400;
  const session = (await context.cookies()).filter(
    (c) => c.expires === -1 && domains.test(c.domain.replace(/^\./, "")),
  );
  if (session.length)
    await context.addCookies(
      session.map(({ name, value, domain, path, httpOnly, secure, sameSite }) => ({
        name,
        value,
        domain,
        path,
        httpOnly,
        secure,
        sameSite,
        expires,
      })),
    );
  return session.length;
}
