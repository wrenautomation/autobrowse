/**
 * Who is watching a run: a caller that starts one with `x-feed-url` (https,
 * on a host in FEED_HOSTS), `x-feed-tag` (opaque, its own id) and an
 * optional W3C `traceparent` gets the run's events posted back
 * (`forwardChannel`). Kept on the run object; `seq` counts its events.
 */
export interface Feed {
  url: string;
  tag: string;
  /** W3C trace context the caller sent; the box's model spans join that trace. */
  traceparent?: string;
}

/** One event's place in its feed: `seq` counts per run, durably, from 1. */
export interface FeedPoint extends Feed {
  seq: number;
}

/** The caller's feed headers are wrong: a 400 before anything runs. */
export class FeedRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedRefused";
  }
}

export const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** `portal.example.com` is that host; `*.example.com` is any host under it, not the apex. */
export function hostAllowed(host: string, hosts: readonly string[]): boolean {
  const h = host.toLowerCase();
  return hosts.some((raw) => {
    const e = raw.trim().toLowerCase();
    if (!e) return false;
    return e.startsWith("*.") ? h.endsWith(e.slice(1)) && h.length > e.length - 1 : h === e;
  });
}

const header = (headers: ReadonlyMap<string, string>, name: string): string | undefined => {
  const exact = headers.get(name);
  if (exact !== undefined) return exact;
  for (const [k, v] of headers) if (k.toLowerCase() === name) return v;
  return undefined;
};

/** The feed a request asks for, or null when it asks for none. Throws `FeedRefused` on a bad one. */
export function feedFrom(
  headers: ReadonlyMap<string, string>,
  hosts: readonly string[],
): Feed | null {
  const raw = header(headers, "x-feed-url");
  if (!raw) return null;
  if (hosts.length === 0) throw new FeedRefused("feeds are off here: FEED_HOSTS is unset");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FeedRefused("x-feed-url is not a URL");
  }
  if (url.protocol !== "https:") throw new FeedRefused("x-feed-url must be https");
  if (url.username || url.password) throw new FeedRefused("x-feed-url carries no credentials");
  if (!hostAllowed(url.hostname, hosts))
    throw new FeedRefused(`x-feed-url host ${url.hostname} is not in FEED_HOSTS`);
  const tag = header(headers, "x-feed-tag") ?? "";
  if (tag.length < 1 || tag.length > 200) throw new FeedRefused("x-feed-tag must be 1-200 chars");
  const tp = header(headers, "traceparent")?.trim().toLowerCase();
  return { url: url.toString(), tag, ...(tp && TRACEPARENT.test(tp) ? { traceparent: tp } : {}) };
}
