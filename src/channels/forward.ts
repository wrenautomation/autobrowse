/**
 * A run's events, live, to whoever started it. The caller names a hook
 * (`x-feed-url`, https on a host in FEED_HOSTS) and a tag (`x-feed-tag`,
 * opaque: its own run id); the box posts `{ tag, traceparent?, events:
 * [{ seq, event }] }` about once a second or every 20 events, bearer
 * FEED_TOKEN. The URL never brings a credential and the allowlist is the
 * SSRF fence. Best effort: a slow or dead hook loses the oldest events
 * past the buffer (a gap in `seq`) and never touches the run.
 */
import type { RunEvent } from "../engine/events.js";
import type { Feed } from "../engine/feed.js";
import type { Channel } from "./types.js";

export interface ForwardOptions {
  /** Sent as a bearer on every post; never from the request, never logged. */
  token?: string;
  fetch?: typeof fetch;
  /** How long an event waits for company before it goes (ms). */
  everyMs?: number;
  /** Events per post. */
  batch?: number;
  /** Events held per feed; past it the oldest go. */
  max?: number;
  /** One line per failed post: host and status, nothing else. */
  log?: (line: string) => void;
}

interface Queue {
  feed: Feed;
  items: { seq: number; event: RunEvent }[];
  /** Posts to one feed go one after another, so its events arrive in order. */
  inflight: Promise<void> | null;
}

export type ForwardChannel = Channel & {
  /** Send everything held now (shutdown, tests). */
  flush(): Promise<void>;
};

/** Delivers only events that carry a feed; every other event passes it by. */
export function forwardChannel(o: ForwardOptions = {}): ForwardChannel {
  const doFetch = o.fetch ?? fetch;
  const everyMs = o.everyMs ?? 1_000;
  const batch = o.batch ?? 20;
  const max = o.max ?? 500;
  const queues = new Map<string, Queue>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const post = async (q: Queue, events: Queue["items"]): Promise<void> => {
    const host = new URL(q.feed.url).hostname;
    try {
      const res = await doFetch(q.feed.url, {
        method: "POST",
        redirect: "manual", // a redirect would walk past the allowlist
        headers: {
          "content-type": "application/json",
          ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
          ...(q.feed.traceparent ? { traceparent: q.feed.traceparent } : {}),
        },
        body: JSON.stringify({
          tag: q.feed.tag,
          ...(q.feed.traceparent ? { traceparent: q.feed.traceparent } : {}),
          events,
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) o.log?.(`feed post to ${host}: ${res.status}`);
    } catch (e) {
      o.log?.(`feed post to ${host}: ${e instanceof Error ? e.name : "failed"}`);
    }
  };

  /** Full batches now; with `all`, the remainder too. */
  const drain = (key: string, q: Queue, all: boolean): Promise<void> => {
    const mine: Promise<void> = (q.inflight ?? Promise.resolve())
      .then(async () => {
        while (q.items.length >= batch || (all && q.items.length > 0))
          await post(q, q.items.splice(0, batch));
      })
      .finally(() => {
        if (q.inflight !== mine) return;
        q.inflight = null;
        if (q.items.length === 0) queues.delete(key);
      });
    q.inflight = mine;
    return mine;
  };

  const flush = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    await Promise.allSettled([...queues].map(([k, q]) => drain(k, q, true)));
  };

  return {
    name: "forward",
    async deliver(event, point) {
      if (!point) return;
      const { seq, ...feed } = point;
      const key = `${feed.url}\n${feed.tag}`;
      const q = queues.get(key) ?? { feed, items: [], inflight: null };
      queues.set(key, q);
      q.items.push({ seq, event });
      if (q.items.length > max) q.items.splice(0, q.items.length - max);
      if (q.items.length >= batch) void drain(key, q, false);
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          void flush();
        }, everyMs);
        timer.unref?.();
      }
    },
    flush,
  };
}
