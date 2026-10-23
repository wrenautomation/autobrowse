import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import {
  commentElements,
  commentUrnsOf,
  linkedinComment,
  linkedinPostComments,
  replyButtonCss,
  targetOf,
  timeOfId,
} from "../src/browser/flows/linkedin-comment.js";
import type { Hints } from "../src/browser/locate.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { linkedin } from "../src/sites/linkedin.js";
import { fakePage } from "./auth-fakes.js";

const PAGE = "urn:li:organization:143656154";
const POST = "urn:li:activity:7513655466959208449";
const onPage = (id: string) =>
  `id="replaceableComment_urn:li:comment:(activity:7513655466959208449,${id})"`;

describe("linkedin comments by the page", () => {
  it("routes comments and comment reads to their flows until Community Management is granted", () => {
    const post = linkedin.routes.find(
      (r) => r.method === "POST" && r.path === "/rest/socialActions/{urn}/comments",
    );
    const read = linkedin.routes.find(
      (r) => r.method === "GET" && r.path === "/rest/socialActions/{urn}/comments",
    );
    expect(post?.browser?.flow).toBe("linkedin/comment");
    expect(read?.browser?.flow).toBe("linkedin/post-comments");
    expect(post?.meter).toBeDefined();
    expect(read?.meter).toBeDefined();
    expect(BROWSER_FLOWS["linkedin/comment"]).toBe(linkedinComment);
    expect(BROWSER_FLOWS["linkedin/post-comments"]).toBe(linkedinPostComments);
    // The Page comments as itself: the leg opens the post acting as the Page.
    const input = post?.browser?.input?.({
      urn: POST,
      actor: PAGE,
      message: { text: "hi" },
    } as never);
    expect(input).toEqual({ urn: POST, text: "hi", actor: PAGE, page: "143656154" });
  });

  it("reads a comment URN, its post and its time", () => {
    expect(targetOf(`urn:li:comment:(${POST},7513656774860636160)`)).toEqual({
      post: POST,
      comment: "7513656774860636160",
    });
    expect(targetOf(POST)).toEqual({ post: POST, comment: null });
    expect(new Date(timeOfId("7513656774860636160")).toISOString()).toBe(
      "2026-10-07T17:49:32.119Z",
    );
    expect(commentUrnsOf(`<div ${onPage("1")}></div><div ${onPage("1")}></div>`)).toEqual([
      `urn:li:comment:(${POST},1)`,
    ]);
  });

  it("comments as the Page and answers the API's shape with the new comment's URN", async () => {
    let sent = false;
    const { fp, acts } = fakePage({
      text: [""],
      url: `https://www.linkedin.com/feed/update/${POST}/?actorCompanyId=143656154`,
      present: (h: Hints) => h.css === "[contenteditable=true]" || /Comment as /.test(h.css ?? ""),
      onAct: (n) => {
        if (n === 2) sent = true;
      },
    });
    fp.html = async () =>
      `<div ${onPage("5")}></div>${sent ? `<div ${onPage("7513656774860636160")}></div>` : ""}`;
    expect(
      await linkedinComment.run(fp, { urn: POST, text: "hi", actor: PAGE, page: "143656154" }),
    ).toEqual({
      id: "7513656774860636160",
      commentUrn: `urn:li:comment:(${POST},7513656774860636160)`,
      $URN: `urn:li:comment:(${POST},7513656774860636160)`,
      actor: PAGE,
      object: POST,
      message: { text: "hi" },
      created: { time: timeOfId("7513656774860636160") },
    });
    expect(acts.map((a) => a.op.kind)).toEqual(["fill", "click"]);
    expect(acts[1]?.hints.css).toContain('has-text("Comment")');
  });

  it("stops before typing when the box would not comment as the Page", async () => {
    const { fp, acts } = fakePage({
      text: [""],
      present: (h: Hints) => h.css === "[contenteditable=true]",
    });
    await expect(
      linkedinComment.run(fp, { urn: POST, text: "hi", actor: PAGE, page: "143656154" }),
    ).rejects.toThrow(/does not act as Page/);
    expect(acts).toEqual([]);
  });

  it("answers a comment from its own Reply, into the reply box", async () => {
    const { fp, acts } = fakePage({
      text: [""],
      present: (h: Hints) =>
        h.css === "[contenteditable=true]" ||
        /Comment as /.test(h.css ?? "") ||
        h.css === replyButtonCss("9"),
    });
    const urn = `urn:li:comment:(${POST},9)`;
    const out = await linkedinComment.run(fp, {
      urn,
      text: "thanks",
      actor: PAGE,
      page: "143656154",
    });
    expect(out).toMatchObject({ commentUrn: null, object: POST, parentComment: urn });
    expect(acts.map((a) => [a.op.kind, a.hints.nth ?? 0])).toEqual([
      ["click", 0],
      ["fill", 1],
      ["click", 0],
    ]);
    expect(acts[2]?.hints.css).toContain('has-text("Reply")');
  });

  it("reads the page's comments in the API's shape: replies under their top comment, the Page by URN", () => {
    const rows = commentElements(
      [
        {
          ref: "activity:1,7513488260065648640",
          left: 329,
          href: "https://www.linkedin.com/in/sam-test/",
          name: "Sam Test",
          text: "Great post … more",
        },
        {
          ref: "activity:1,7513516083404922880",
          left: 369,
          href: "https://www.linkedin.com/company/wrenautomation/",
          name: "Wren",
          text: "Thanks",
        },
        {
          ref: "activity:1,7513524938750808064",
          left: 329,
          href: "https://www.linkedin.com/company/42/",
          name: "Acme",
          text: "Agreed",
        },
      ],
      { wrenautomation: "143656154" },
    );
    expect(rows.map((r) => [r.actor, r.parentComment ?? null, r.message.text])).toEqual([
      ["https://www.linkedin.com/in/sam-test/", null, "Great post"],
      [PAGE, "urn:li:comment:(urn:li:activity:1,7513488260065648640)", "Thanks"],
      ["urn:li:organization:42", null, "Agreed"],
    ]);
    expect(rows[0]).toMatchObject({
      commentUrn: "urn:li:comment:(urn:li:activity:1,7513488260065648640)",
      object: "urn:li:activity:1",
      actorName: "Sam Test",
      created: { time: timeOfId("7513488260065648640") },
    });
  });
});

describe("linkedin reply: the comment found by its own id", () => {
  it("a urn that names the post as a share finds the comment the page keys by activity", async () => {
    // Synthetic ids: the page keys comments by the post's activity id, the urn by its share id.
    const html = `<main>
      <article id="replaceableComment_urn:li:comment:(activity:7000000000000000001,7000000000000000009)">
        <button aria-label="Reply">Reply</button></article>
      <article id="replaceableComment_urn:li:comment:(activity:7000000000000000001,7000000000000000099)">
        <button aria-label="Reply">Reply</button></article></main>`;
    const urn = "urn:li:comment:(urn:li:share:7000000000000000002,7000000000000000009)";
    const { comment } = targetOf(urn);
    expect(comment).toBe("7000000000000000009");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(html);
      const found = await page.$$eval(replyButtonCss(comment as string), (els) =>
        els.map((e) => (e.closest("article") as { id: string }).id),
      );
      // Only that comment: a comment id that ends the same digits (…099) is another comment.
      expect(found).toEqual([
        "replaceableComment_urn:li:comment:(activity:7000000000000000001,7000000000000000009)",
      ]);
    } finally {
      await browser.close();
    }
  });
});

describe("a post's counts bar", () => {
  it("reads reactions first, then comments and reposts by their words", async () => {
    const { postCountsOf } = await import("../src/browser/flows/linkedin-comment.js");
    expect(postCountsOf("12\n3 comments\n1 repost")).toEqual({
      reactions: 12,
      comments: 3,
      reposts: 1,
    });
    expect(postCountsOf("Ann Lee and 1.2K others\n40 comments")).toEqual({
      reactions: 1201,
      comments: 40,
      reposts: 0,
    });
    expect(postCountsOf("1 comment")).toEqual({ reactions: 0, comments: 1, reposts: 0 });
    expect(postCountsOf("")).toEqual({ reactions: 0, comments: 0, reposts: 0 });
  });
});
