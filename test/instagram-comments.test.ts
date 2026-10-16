import { describe, expect, it } from "vitest";
import type { FlowPage } from "../src/browser/flow.js";
import {
  commentsIn,
  instagramPostComments,
  jsonsOf,
  mergeIgComments,
} from "../src/browser/flows/instagram-comments.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { instagram } from "../src/sites/instagram.js";
import { fakePage } from "./auth-fakes.js";

// Synthetic comments in the shape of Instagram's post page; no real posts or people.
const T = 1_790_000_000;
const iso = (secs: number) => new Date(secs * 1000).toISOString();
const CODE = "AbC123xyz";
const LIST = "xdt_api__v1__media__media_id__comments__connection";
const node = (pk: string, username: string, text: string, at: number, extra = {}) => ({
  node: {
    pk,
    text,
    created_at: at,
    user: { pk: `u${pk}`, id: `u${pk}`, username },
    parent_comment_id: null,
    comment_like_count: 1,
    __typename: "XDTCommentDict",
    ...extra,
  },
  cursor: "",
});
const listOf = (edges: unknown[], more: boolean) => ({
  [LIST]: { edges, page_info: { has_next_page: more, end_cursor: more ? "c1" : null } },
});
/** The page's prefetch blob: Relay's nesting around the list. */
const BLOB = JSON.stringify({
  require: [
    [
      "ScheduledServerJS",
      "handle",
      null,
      [
        {
          __bbox: {
            result: {
              data: listOf(
                [
                  node("11", "viewer_one", "Lovely shot", T + 10),
                  node("12", "viewer_two", "Where is this?", T + 30, {
                    preview_child_comments: [
                      {
                        pk: "21",
                        text: "Up north",
                        created_at: T + 40,
                        user: { username: "owner_acct" },
                      },
                    ],
                  }),
                ],
                true,
              ),
            },
          },
        },
      ],
    ],
  ],
});
const PAGE_2 = { data: listOf([node("13", "our_acct", "Great light here", T + 50)], false) };
const HEAD = `<meta property="og:description" content="10 likes, 3 comments - owner_acct on October 1, 2026: &quot;A walk&quot;">`;

describe("instagram post comments: parsing", () => {
  it("reads comment nodes anywhere, replies under their parent, never a caption", () => {
    const got = commentsIn(JSON.parse(BLOB));
    expect(got.more).toBe(true);
    expect(got.comments.map((c) => [c.id, c.username, c.parentId])).toEqual([
      ["11", "viewer_one", null],
      ["12", "viewer_two", null],
      ["21", "owner_acct", "12"],
    ]);
    expect(got.comments[0]).toEqual({
      id: "11",
      username: "viewer_one",
      userId: "u11",
      text: "Lovely shot",
      at: iso(T + 10),
      parentId: null,
      likes: 1,
    });
    const caption = {
      caption: { pk: "9", text: "A walk", created_at: T, user: { username: "x" } },
    };
    expect(commentsIn({ items: [caption] }).comments).toEqual([]);
  });

  it("reads Relay answers line by line, past a for(;;) guard and a cut line", () => {
    const text = `for (;;);${JSON.stringify(PAGE_2)}\n{"cut":\n${JSON.stringify({ a: 1 })}`;
    expect(jsonsOf(text)).toEqual([PAGE_2, { a: 1 }]);
  });

  it("merges by id, newest first", () => {
    const rows = [
      ...commentsIn(JSON.parse(BLOB)).comments,
      ...commentsIn(PAGE_2).comments,
      ...commentsIn(JSON.parse(BLOB)).comments,
    ];
    expect(mergeIgComments(rows).map((c) => c.id)).toEqual(["13", "21", "12", "11"]);
  });
});

describe("instagram post comments: the flow and the route", () => {
  type Handler = (r: { url(): string; text(): Promise<string> }) => void;

  const postPage = (opts: { html?: string; text?: string; url?: string; blobs?: string[] }) => {
    const { fp, acts } = fakePage({ text: [opts.text ?? "Post"], present: () => true });
    const handlers = new Set<Handler>();
    const opened: string[] = [];
    let scrolls = 0;
    fp.page = {
      on: (_e: string, h: Handler) => handlers.add(h),
      off: (_e: string, h: Handler) => handlers.delete(h),
      evaluate: async (fn: unknown) => {
        const src = String(fn);
        if (src.includes("data-sjs")) return opts.blobs ?? [BLOB];
        scrolls++;
        // The first scroll loads the next page; the others bring nothing.
        if (scrolls === 1)
          for (const h of handlers)
            h({
              url: () => "https://www.instagram.com/api/graphql",
              text: async () => JSON.stringify(PAGE_2),
            });
        return true;
      },
    } as unknown as FlowPage["page"];
    fp.open = async (url) => {
      opened.push(url);
    };
    fp.url = () => opts.url ?? opened.at(-1) ?? "";
    fp.html = async () => opts.html ?? HEAD;
    fp.scroll = async () => {};
    return { fp, acts, opened, scrolls: () => scrolls, handlers };
  };

  it("reads the embedded comments, scrolls for the rest; never clicks or types", async () => {
    const page = postPage({});
    const out = await instagramPostComments.run(page.fp, { shortcode: CODE });
    if ("found" in out) throw new Error("not found");
    expect(page.opened).toEqual([`https://www.instagram.com/p/${CODE}/`]);
    expect(out.owner).toBe("owner_acct");
    expect(out.comments.map((c) => c.id)).toEqual(["13", "21", "12", "11"]);
    expect(out.more).toBe(false);
    // The second page said no more: one scroll.
    expect(page.scrolls()).toBe(1);
    expect(page.acts).toEqual([]);
    expect(page.handlers.size).toBe(0);
  });

  it("stops at max and says more", async () => {
    const page = postPage({});
    const out = await instagramPostComments.run(page.fp, { shortcode: CODE, max: 2 });
    if ("found" in out) throw new Error("not found");
    expect(out.comments.map((c) => c.id)).toEqual(["21", "12"]);
    expect(out.more).toBe(true);
    expect(page.scrolls()).toBe(0);
  });

  it("answers found false for a missing post; a person for signed out or a bad code", async () => {
    const gone = postPage({ html: "", text: "Sorry, this page isn't available." });
    expect(await instagramPostComments.run(gone.fp, { shortcode: CODE })).toEqual({
      found: false,
      reason: `no Instagram post ${CODE}`,
    });
    const out = postPage({ url: "https://www.instagram.com/accounts/login/?next=x" });
    await expect(instagramPostComments.run(out.fp, { shortcode: CODE })).rejects.toThrow(
      /signed out/,
    );
    await expect(instagramPostComments.run(postPage({}).fp, { shortcode: "../x" })).rejects.toThrow(
      /not a post code/,
    );
  });

  it("is a metered read route on the instagram site", () => {
    const r = instagram.routes.find(
      (r) => r.method === "GET" && r.path === "/web/p/{shortcode}/comments",
    );
    expect(r?.browser?.flow).toBe("instagram/post-comments");
    expect(r?.meter?.({})).toEqual({ comments: 1 });
    expect(r?.irreversible).toBeUndefined();
    expect(instagram.caps?.comments).toBeGreaterThan(0);
    expect(BROWSER_FLOWS["instagram/post-comments"]).toBe(instagramPostComments);
    expect(r?.request.parse({ shortcode: CODE })).toEqual({ shortcode: CODE, max: 100 });
  });
});
