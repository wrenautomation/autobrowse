/**
 * A stand-in site for the send-verdict tests (designs/2026-10-16-send-verdicts.md): a browser-leg
 * comment, an API-leg video publish, and reads of both. `platform` is what it holds and how its
 * next write ends. Synthetic: no real site, name or id.
 */
import { z } from "zod";
import { already, currentCall, fileDoneActs, markSubmitted } from "../src/browser/attempt.js";
import { ProfileBusy } from "../src/browser/browsers.js";
import { defineFlow, type FlowRunner } from "../src/browser/flow.js";
import { HttpError, httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { route, type SiteApi, type SiteFacade, siteFacade } from "../src/sites/index.js";
import { SiteError } from "../src/sites/types.js";

/** What the fake platform holds, and what its next write does. */
export const platform = {
  comments: [] as { text: string; at: string; id: string }[],
  videos: [] as { title: string; at: string; id: string; visible: boolean }[],
  /** `ok` answers; `close` posts then the page dies; `died` the page dies at the click, nothing posted. */
  /** `missing`: the flow answers `{ found: false }` before any act; `closed`: the same with a 403 (comments off); `already`: it is already there. */
  mode: "ok" as
    | "ok"
    | "close"
    | "died"
    | "lost"
    | "refuse"
    | "limit"
    | "hold"
    | "busy"
    | "missing"
    | "closed"
    | "already",
  /** The video list shows a new video only after processing. */
  lagging: false,
  /** Every write that reached the platform. */
  writes: [] as string[],
  /** `hold`: the leg waits here after its submit step. */
  release: Promise.resolve(),
  /** The send key each leg ran under (`currentCall`). */
  keys: [] as (string | undefined)[],
  /** Runs as an act goes out, with the send key (the test reads the journal there). */
  onAct: null as null | ((key: string) => void),
  reads: 0,
};

/** The send key of the call this leg runs under (`send <key>`). */
const sendKeyOf = () => currentCall()?.replace(/^send /, "") ?? "";

const comment = defineFlow<{ thread: string; text: string }, { id: string; url: string }>({
  site: "scratch",
  name: "comment",
  async run() {
    throw new Error("the fake runner answers this");
  },
});

/** The browser: what a flow does when its irreversible act goes through and then the page dies. */
export const runner: FlowRunner = {
  async run(flow, input) {
    const { text } = input as { text: string };
    platform.keys.push(currentCall());
    if (platform.mode === "busy") throw new ProfileBusy("scratch", 4242, "cli", "");
    const { thread } = input as { thread: string };
    if (platform.mode === "missing")
      return { found: false, reason: `no thread ${thread}` } as never;
    if (platform.mode === "closed")
      return { found: false, status: 403, reason: `comments are off on ${thread}` } as never;
    if (platform.mode === "already")
      return already({ id: "c0", url: "https://scratch.test/c/c0" }) as never;
    markSubmitted();
    platform.onAct?.(sendKeyOf());
    if (platform.mode === "died") throw new Error("page closed at the click");
    const id = `c${platform.comments.length + 1}`;
    platform.comments.unshift({ text, at: new Date().toISOString(), id });
    platform.writes.push(`${flow.name} ${text}`);
    if (platform.mode === "hold") await platform.release;
    if (platform.mode === "close" || platform.mode === "hold")
      throw new Error("page closed after Post");
    return { id, url: `https://scratch.test/c/${id}` } as never;
  },
};

export const scratch: SiteApi = {
  site: "scratch",
  origin: "https://scratch.test",
  auth: { open: true },
  setup: [],
  routes: [
    route({
      method: "GET",
      path: "/comments",
      request: z.object({ thread: z.string() }),
      summary: "A thread's comments, newest first",
      api: async () => ({ items: platform.comments }),
    }),
    route({
      method: "POST",
      path: "/videos/list",
      request: z.object({}),
      summary: "The account's videos (a POST that only reads)",
      api: async () => ({ videos: platform.videos.filter((v) => v.visible) }),
    }),
    route({
      method: "POST",
      path: "/comments",
      request: z.object({ thread: z.string(), text: z.string() }),
      summary: "Comment on a thread",
      irreversible: true,
      browser: { flow: "scratch/comment" },
      sentAs: (o: { id: string; url: string }) => ({ id: o.id, url: o.url }),
      verify: {
        words: (i: { thread: string; text: string }) => i.text,
        read: async (i: { thread: string; text: string }, get) => {
          platform.reads += 1;
          const got = (await get("/comments", { thread: i.thread })) as {
            items: { text: string; at: string; id: string }[];
          };
          return {
            rows: got.items.map((c) => ({ words: c.text, at: c.at, id: c.id, url: null })),
            order: "newest" as const,
            complete: true,
          };
        },
      },
    }),
    route({
      method: "POST",
      path: "/dms",
      request: z.object({ to: z.string(), text: z.string() }),
      summary: "A DM whose flow nobody recorded",
      irreversible: true,
      browser: { flow: "scratch/dm" },
      verify: { none: "no list shows a DM we sent" },
    }),
    route({
      method: "POST",
      path: "/pins",
      request: z.object({ note: z.string() }),
      summary: "Pin a note: nothing lists it",
      irreversible: true,
      verify: { none: "no list shows a pinned note" },
      api: async (i: { note: string }) => {
        platform.writes.push(`pin ${i.note}`);
        throw new Error("socket hang up");
      },
    }),
    route({
      method: "POST",
      path: "/videos",
      request: z.object({ title: z.string() }),
      summary: "Publish a video",
      irreversible: true,
      sentAs: (o: { id: string }) => ({ id: o.id, url: `https://scratch.test/v/${o.id}` }),
      verify: {
        words: (i: { title: string }) => i.title,
        lags: () => "a new video shows in the list only after processing",
        read: async (_i: { title: string }, get) => {
          platform.reads += 1;
          const got = (await get("/videos/list", {}, { method: "POST" })) as {
            videos: { title: string; at: string; id: string }[];
          };
          return {
            rows: got.videos.map((v) => ({ words: v.title, at: v.at, id: v.id, url: null })),
            order: "newest" as const,
            complete: false,
          };
        },
      },
      api: async (i: { title: string }) => {
        platform.keys.push(currentCall());
        platform.onAct?.(sendKeyOf());
        platform.writes.push(`video ${i.title}`);
        if (platform.mode === "refuse")
          throw new HttpError("POST", "https://scratch.test/videos", 403);
        // The site's own no, read off the page after the submit (LinkedIn's weekly limit).
        if (platform.mode === "limit")
          throw new SiteError(429, "weekly limit; retry after 86400s", 86_400);
        const id = `v:${i.title}`;
        platform.videos.unshift({
          title: i.title,
          at: new Date().toISOString(),
          id,
          visible: !platform.lagging,
        });
        // The request went out and the platform has it; the answer never comes back.
        if (platform.mode === "hold") await platform.release;
        if (platform.mode === "lost" || platform.mode === "hold") throw new Error("socket hang up");
        return { id };
      },
    }),
  ],
};

/** The facade over the stand-in site. Browser flow `scratch/comment` is recorded; `scratch/dm` is not. */
export function scratchFacade(startedDir: string): SiteFacade {
  return siteFacade([scratch], {
    http: httpClient(),
    env: () => undefined,
    sink: memorySink(),
    runner,
    flow: (name) => (name === "scratch/comment" ? (comment as never) : null),
    started: fileDoneActs(startedDir),
  });
}

/** The platform as new: an old video, so a list read reaches back past a send. */
export function resetPlatform(): void {
  platform.comments = [];
  platform.videos = [
    { title: "old video", at: "2026-01-01T00:00:00.000Z", id: "v:old", visible: true },
  ];
  platform.mode = "ok";
  platform.lagging = false;
  platform.writes = [];
  platform.release = Promise.resolve();
  platform.keys = [];
  platform.onAct = null;
  platform.reads = 0;
}
