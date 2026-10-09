import { describe, expect, it } from "vitest";
import type { FlowPage } from "../src/browser/flow.js";
import {
  commentRows,
  isCreator,
  mergeComments,
  replyParentOf,
  tiktokPostComments,
  videoAuthorIdIn,
  videoUrl,
} from "../src/browser/flows/tiktok-comments.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { memoryCaps } from "../src/sites/caps.js";
import { siteFacade } from "../src/sites/facade.js";
import { tiktok } from "../src/sites/tiktok.js";
import { fakePage } from "./auth-fakes.js";
import { fakeBrowser, fakeFetch } from "./fakes.js";

// Synthetic comment calls in TikTok's shape; no real videos or people.
const T = 1_790_000_000;
const iso = (secs: number) => new Date(secs * 1000).toISOString();
const AUTHOR = "555";
const VIDEO = "7400000000000000001";
const TOP = {
  comments: [
    {
      cid: "101",
      text: "Great tip",
      create_time: T,
      user: { uid: "900", unique_id: "viewer_one", nickname: "Viewer One" },
      reply_id: "0",
      reply_to_reply_id: "0",
      digg_count: 4,
      label_list: null,
      is_author_digged: true,
      reply_comment: [
        {
          cid: "201",
          text: "Thanks",
          create_time: T + 100,
          user: { uid: AUTHOR, unique_id: "the_creator", nickname: "Creator Name" },
          reply_id: "101",
          reply_to_reply_id: "0",
          digg_count: 1,
          label_list: [{ type: 1, text: "Creator" }],
        },
      ],
      reply_comment_total: 2,
    },
    {
      cid: "102",
      text: "How long did it take?",
      create_time: T + 50,
      user: { uid: "901", unique_id: "viewer_two", nickname: "" },
      reply_id: "0",
    },
    { text: "no id, dropped", create_time: T },
  ],
  has_more: 1,
};
const MORE = {
  comments: [
    {
      cid: "103",
      text: "Older one",
      create_time: T - 500,
      user: { uid: "902", unique_id: "viewer_three", nickname: "Three" },
      reply_id: "0",
      digg_count: 0,
    },
    TOP.comments[1],
  ],
};
const REPLIES = {
  comments: [
    TOP.comments[0]?.reply_comment?.[0],
    {
      cid: "202",
      text: "One more thing",
      create_time: T + 200,
      user: { uid: AUTHOR, unique_id: "the_creator", nickname: "Creator Name" },
      digg_count: 2,
    },
  ],
};
const DATA = JSON.stringify({
  __DEFAULT_SCOPE__: {
    "webapp.video-detail": { itemInfo: { itemStruct: { id: VIDEO, author: { id: AUTHOR } } } },
  },
});

describe("tiktok comments: the calls' JSON", () => {
  it("makes rows from top-level comments and their reply previews", () => {
    expect(commentRows(TOP, AUTHOR)).toEqual([
      {
        id: "101",
        text: "Great tip",
        at: iso(T),
        author: "viewer_one",
        authorName: "Viewer One",
        authorId: "900",
        parentId: null,
        creator: false,
        likes: 4,
      },
      {
        id: "201",
        text: "Thanks",
        at: iso(T + 100),
        author: "the_creator",
        authorName: "Creator Name",
        authorId: AUTHOR,
        parentId: "101",
        creator: true,
        likes: 1,
      },
      {
        id: "102",
        text: "How long did it take?",
        at: iso(T + 50),
        author: "viewer_two",
        authorName: null,
        authorId: "901",
        parentId: null,
        creator: false,
        likes: null,
      },
    ]);
    expect(commentRows({ status_code: 0 }, AUTHOR)).toEqual([]);
    expect(commentRows(null, AUTHOR)).toEqual([]);
  });

  it("a reply call's rows take the asked comment as parent when they do not name one", () => {
    const rows = commentRows(REPLIES, AUTHOR, "101");
    expect(rows.map((r) => [r.id, r.parentId, r.creator])).toEqual([
      ["201", "101", true],
      ["202", "101", true],
    ]);
    expect(
      replyParentOf("https://www.tiktok.com/api/comment/list/reply/?comment_id=101&item_id=7"),
    ).toBe("101");
    expect(replyParentOf("https://www.tiktok.com/api/comment/list/reply/?item_id=7")).toBeNull();
  });

  it("marks the creator by author id or by TikTok's Creator label", () => {
    expect(isCreator(AUTHOR, AUTHOR, null)).toBe(true);
    expect(isCreator("900", AUTHOR, [{ type: 1, text: "Creator" }])).toBe(true);
    expect(isCreator("900", AUTHOR, [{ type: 2, text: "Pinned" }])).toBe(false);
    expect(isCreator(null, null, null)).toBe(false);
    // An author like is not authorship.
    expect(commentRows(TOP, null)[0]?.creator).toBe(false);
    // Without the author id, the label still marks it.
    expect(commentRows(TOP, null)[1]?.creator).toBe(true);
  });

  it("keeps one row per id, newest first, rows with no time last", () => {
    const rows = [
      ...commentRows(TOP, AUTHOR),
      ...commentRows(MORE, AUTHOR),
      ...commentRows({ comments: [{ cid: "104", text: "?" }] }, AUTHOR),
    ];
    const merged = mergeComments(rows);
    expect(merged.map((r) => r.id)).toEqual(["201", "102", "101", "103", "104"]);
    expect(merged.at(-1)?.at).toBe("");
  });

  it("finds the video's author in the page data; builds the video url", () => {
    expect(videoAuthorIdIn(DATA)).toBe(AUTHOR);
    expect(videoAuthorIdIn("{}")).toBeNull();
    expect(videoAuthorIdIn("not json")).toBeNull();
    expect(videoAuthorIdIn(null)).toBeNull();
    expect(videoUrl(VIDEO)).toBe(`https://www.tiktok.com/@_/video/${VIDEO}`);
    expect(videoUrl(VIDEO, "@the_creator")).toBe(
      `https://www.tiktok.com/@the_creator/video/${VIDEO}`,
    );
  });
});

describe("tiktok comments: the flow and the route", () => {
  type Handler = (r: { url(): string; json(): Promise<unknown> }) => void;

  /** A video page that answers its comment calls as the fake is driven. */
  const videoPage = (opts: { onOpen?: unknown[]; onScroll?: unknown[]; text?: string }) => {
    const { fp, acts } = fakePage({ text: [opts.text ?? "Video"], present: () => true });
    const handlers = new Set<Handler>();
    const emit = (url: string, body: unknown) => {
      for (const h of handlers) h({ url: () => url, json: async () => body });
    };
    const list = `https://www.tiktok.com/api/comment/list/?aweme_id=${VIDEO}`;
    const opened: string[] = [];
    const scrolls = [...(opts.onScroll ?? [])];
    let replyButtons = 1;
    let clicks = 0;
    const evaluated: string[] = [];
    fp.page = {
      on: (_e: string, h: Handler) => handlers.add(h),
      off: (_e: string, h: Handler) => handlers.delete(h),
      evaluate: async (fn: unknown) => {
        const src = String(fn);
        if (src.includes("getElementById")) return DATA;
        evaluated.push("scroll");
        const body = scrolls.shift();
        if (body) emit(list, body);
        return true;
      },
      getByText: (re: RegExp) => ({
        first: () => ({
          isVisible: async () => re.test("View 2 replies") && replyButtons > 0,
          click: async () => {
            clicks++;
            replyButtons--;
            emit(
              `https://www.tiktok.com/api/comment/list/reply/?comment_id=101&item_id=${VIDEO}`,
              REPLIES,
            );
          },
        }),
      }),
    } as unknown as FlowPage["page"];
    fp.open = async (url) => {
      opened.push(url);
      for (const body of opts.onOpen ?? []) emit(list, body);
    };
    fp.url = () => opened.at(-1) ?? "";
    fp.scroll = async () => {};
    return { fp, acts, opened, evaluated, clicks: () => clicks, handlers };
  };

  it("reads comments, more by scrolling and replies by one click; never types or likes", async () => {
    const page = videoPage({ onOpen: [TOP], onScroll: [MORE] });
    const out = await tiktokPostComments.run(page.fp, { videoId: VIDEO });
    expect(page.opened).toEqual([`https://www.tiktok.com/@_/video/${VIDEO}`]);
    expect(out.videoId).toBe(VIDEO);
    expect(out.url).toBe(`https://www.tiktok.com/@_/video/${VIDEO}`);
    expect(out.comments.map((c) => [c.id, c.parentId, c.creator])).toEqual([
      ["202", "101", true],
      ["201", "101", true],
      ["102", null, false],
      ["101", null, false],
      ["103", null, false],
    ]);
    expect(page.clicks()).toBe(1);
    expect(page.acts).toEqual([]);
    // Two scrolls with nothing new end the scrolling: one that brought MORE, then two empty.
    expect(page.evaluated).toHaveLength(3);
    expect(page.handlers.size).toBe(0);
  });

  it("stops at max", async () => {
    const page = videoPage({ onOpen: [TOP], onScroll: [MORE] });
    const out = await tiktokPostComments.run(page.fp, { videoId: VIDEO, username: "x", max: 2 });
    expect(out.comments.map((c) => c.id)).toEqual(["202", "201"]);
    expect(page.evaluated).toHaveLength(0);
  });

  it("goes to a person when no comment call comes or the id is not one", async () => {
    await expect(
      tiktokPostComments.run(videoPage({ text: "Video currently unavailable" }).fp, {
        videoId: VIDEO,
      }),
    ).rejects.toThrow(/not there/);
    const silent = videoPage({});
    await expect(tiktokPostComments.run(silent.fp, { videoId: VIDEO })).rejects.toThrow(
      /made no comment call/,
    );
    expect(silent.handlers.size).toBe(0);
    await expect(tiktokPostComments.run(videoPage({}).fp, { videoId: "../x" })).rejects.toThrow(
      /not a TikTok video id/,
    );
  });

  it("GET /web/videos/{videoId}/comments runs the flow under the comments cap of 24 a day", async () => {
    const seen: unknown[] = [];
    const browser = fakeBrowser([]);
    browser.on(tiktokPostComments, async (i) => {
      seen.push(i);
      return { videoId: i.videoId, url: "u", comments: [] };
    });
    const caps = memoryCaps(() => Date.UTC(2026, 8, 29, 12));
    const sites = siteFacade([tiktok], {
      http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      env: () => undefined,
      sink: memorySink(),
      runner: browser,
      flow: (n) => BROWSER_FLOWS[n] ?? null,
      caps,
    });
    const path = `/web/videos/${VIDEO}/comments`;
    expect(await sites.call("tiktok", "GET", path, { username: "the_creator", max: "20" })).toEqual(
      { videoId: VIDEO, url: "u", comments: [] },
    );
    expect(seen).toEqual([{ videoId: VIDEO, username: "the_creator", max: 20 }]);
    await expect(sites.call("tiktok", "GET", path, { max: "101" })).rejects.toThrow();
    for (let i = 1; i < 24; i++) await sites.call("tiktok", "GET", path, {});
    expect(seen.at(-1)).toEqual({ videoId: VIDEO, max: 50 });
    await expect(sites.call("tiktok", "GET", path, {})).rejects.toMatchObject({ status: 429 });
    expect(seen).toHaveLength(24);
    expect(tiktok.caps).toEqual({ comments: 24 });
    const r = tiktok.routes.find((x) => x.path === "/web/videos/{videoId}/comments");
    expect(r?.meter?.({} as never)).toEqual({ comments: 1 });
    expect(r?.browser).toEqual({ flow: "tiktok/post-comments" });
    expect(BROWSER_FLOWS["tiktok/post-comments"]).toBe(tiktokPostComments);
  });
});
