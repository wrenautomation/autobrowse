import { describe, expect, it } from "vitest";
import {
  countOf,
  igPostOf,
  instagramComment,
  instagramFollow,
  instagramLike,
  postCodesOf,
} from "../src/browser/flows/instagram-act.js";
import { linkedinFollow, linkedinLike } from "../src/browser/flows/linkedin-act.js";
import { postsSearchUrl } from "../src/browser/flows/linkedin-posts.js";
import {
  followButton,
  followingButton,
  likeButton,
  meOf,
  postsBy,
  unlikeButton,
  xFollow,
  xLike,
  xReply,
} from "../src/browser/flows/x-act.js";
import type { Hints } from "../src/browser/locate.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { instagram } from "../src/sites/instagram.js";
import { linkedin } from "../src/sites/linkedin.js";
import { prefersBrowser } from "../src/sites/types.js";
import { x } from "../src/sites/x.js";
import { fakePage } from "./auth-fakes.js";

const same = (a: Hints, b: Hints) => JSON.stringify(a) === JSON.stringify(b);

describe("social act routes", () => {
  it("send follows, likes and comments to their browser flows, each metered", () => {
    const legs: Array<[typeof x, string, string, string]> = [
      [x, "POST", "/2/users/me/following", "x/follow"],
      [x, "POST", "/2/users/me/likes", "x/like"],
      [instagram, "POST", "/web/{username}/follow", "instagram/follow"],
      [instagram, "POST", "/web/p/{shortcode}/like", "instagram/like"],
      [instagram, "POST", "/web/p/{shortcode}/comments", "instagram/comment"],
      [instagram, "GET", "/web/p/{shortcode}", "instagram/post"],
      [instagram, "GET", "/web/search", "instagram/search"],
      [linkedin, "POST", "/in/{vanity}/follow", "linkedin/follow"],
      [linkedin, "POST", "/company/{company}/follow", "linkedin/follow"],
      [linkedin, "POST", "/feed/update/{urn}/like", "linkedin/like"],
    ];
    for (const [site, method, path, flow] of legs) {
      const r = site.routes.find((r) => r.method === method && r.path === path);
      expect(r?.browser?.flow, path).toBe(flow);
      expect(r?.meter, path).toBeDefined();
      expect(BROWSER_FLOWS[flow], flow).toBeDefined();
    }
    expect(
      instagram.routes.find((r) => r.path === "/web/p/{shortcode}/comments")?.irreversible,
    ).toBe(true);
  });

  it("sends a text-only X reply through the page and anything else to the API", () => {
    const r = x.routes.find((r) => r.method === "POST" && r.path === "/2/tweets");
    if (!r) throw new Error("no /2/tweets");
    const reply = { text: "good point", reply: { in_reply_to_tweet_id: "123" } };
    expect(prefersBrowser(r, reply)).toBe(true);
    expect(r.browser?.input?.(reply, () => undefined)).toEqual({ id: "123", text: "good point" });
    expect(r.meter?.(reply)).toEqual({ reply: 1 });
    expect(prefersBrowser(r, { text: "a post" })).toBe(false);
    expect(prefersBrowser(r, { ...reply, media: { media_ids: ["9"] } })).toBe(false);
  });

  it("never lets William's LinkedIn or the alt like or follow", () => {
    expect(linkedin.caps?.like).toBeGreaterThan(0);
    for (const acct of ["linkedin", "linkedin@alt"]) {
      expect(linkedin.accountCaps?.[acct]?.like).toBe(0);
      expect(linkedin.accountCaps?.[acct]?.follow).toBe(0);
    }
  });

  it("filters LinkedIn's post search by the author's title", () => {
    const u = new URL(postsSearchUrl("staffing agency", "past-week", "founder"));
    expect(u.searchParams.get("authorJobTitle")).toBe('"founder"');
    expect(new URL(postsSearchUrl("staffing agency")).searchParams.has("authorJobTitle")).toBe(
      false,
    );
  });
});

describe("x acts", () => {
  it("follows once and reads the Following button back", async () => {
    let clicked = false;
    const { fp, acts } = fakePage({
      text: [""],
      url: "https://x.com/acme",
      present: (h) => (clicked ? same(h, followingButton("acme")) : same(h, followButton("acme"))),
      onAct: () => {
        clicked = true;
      },
    });
    expect(await xFollow.run(fp, { username: "acme" })).toEqual({
      data: { following: true, pending_follow: false },
    });
    expect(acts).toHaveLength(1);
  });

  it("does nothing on a post already liked", async () => {
    const { fp, acts } = fakePage({
      text: [""],
      url: "https://x.com/i/status/5",
      present: (h) => same(h, unlikeButton("5")),
    });
    expect(await xLike.run(fp, { id: "5" })).toEqual({ data: { liked: true, already: true } });
    expect(acts).toEqual([]);
  });

  it("answers a missing post as the API does", async () => {
    const { fp } = fakePage({
      text: ["Hmm...this page doesn't exist. Try searching for something else."],
      url: "https://x.com/i/status/5",
      present: (h) => same(h, likeButton("6")),
    });
    expect(await xLike.run(fp, { id: "5" })).toMatchObject({
      errors: [{ title: "Not Found Error" }],
    });
  });

  it("replies and returns the new post's id", async () => {
    const rail = '<a href="/wren_automation" data-testid="AppTabBar_Profile_Link" role="link">';
    let sent = false;
    const { fp, acts } = fakePage({
      text: [""],
      url: "https://x.com/acme/status/5",
      present: () => true,
      onAct: (n) => {
        if (n === 2) sent = true;
      },
    });
    fp.html = async () =>
      `${rail}<a href="/acme/status/5">x</a>${sent ? '<a href="/wren_automation/status/77">y</a>' : ""}`;
    expect(await xReply.run(fp, { id: "5", text: "hi" })).toEqual({
      data: { id: "77", text: "hi" },
    });
    expect(acts.map((a) => a.op.kind)).toEqual(["fill", "click"]);
  });

  it("reads who is signed in and their posts off the page", () => {
    expect(
      meOf('<a data-testid="AppTabBar_Profile_Link" href="/wren_automation" role="link">'),
    ).toBe("wren_automation");
    expect(
      postsBy('<a href="/Me/status/1"></a><a href="/me/status/1/analytics"></a>', "me"),
    ).toEqual(["1"]);
  });
});

describe("instagram acts", () => {
  it("reads a post page's tags", () => {
    const html = `<meta property="og:description" content="184K likes, 288 comments - natgeo on October 7, 2026: &quot;A bear &amp; salmon.&quot;. "><time class="x" datetime="2026-10-07T16:00:02.000Z">`;
    expect(igPostOf(html, "DeNRL")).toEqual({
      shortcode: "DeNRL",
      url: "https://www.instagram.com/p/DeNRL/",
      username: "natgeo",
      caption: "A bear & salmon.",
      likes: 184_000,
      comments: 288,
      timestamp: "2026-10-07T16:00:02.000Z",
    });
    expect(igPostOf(html.replace(/<time.*$/, ""), "DeNRL")?.timestamp).toBe(
      "2026-10-07T00:00:00.000Z",
    );
    expect(countOf("1.2M")).toBe(1_200_000);
    expect(countOf("1,024")).toBe(1024);
    expect(postCodesOf(["/p/AAA111/", "/natgeo/reel/BBB222/", "/p/AAA111/", "/explore/"])).toEqual([
      "AAA111",
      "BBB222",
    ]);
  });

  it("follows, likes and comments with one act each", async () => {
    const run = async (flow: "follow" | "like" | "comment") => {
      let done = false;
      const { fp, acts } = fakePage({
        text: [""],
        url: "https://www.instagram.com/acme/",
        present: (h) => {
          const css = `${h.css ?? ""}${h.name ?? ""}`;
          if (/following\|requested|Unlike/.test(css)) return done;
          return !done || /textarea/.test(css);
        },
        onAct: (n) => {
          if (n >= (flow === "comment" ? 2 : 1)) done = true;
        },
      });
      const out =
        flow === "follow"
          ? await instagramFollow.run(fp, { username: "acme" })
          : flow === "like"
            ? await instagramLike.run(fp, { shortcode: "AAA111" })
            : await instagramComment.run(fp, { shortcode: "AAA111", text: "nice" });
      return { out, acts: acts.map((a) => a.op.kind) };
    };
    expect(await run("follow")).toEqual({
      out: { username: "acme", following: true },
      acts: ["click"],
    });
    expect(await run("like")).toEqual({
      out: { shortcode: "AAA111", liked: true },
      acts: ["click"],
    });
    expect(await run("comment")).toEqual({
      out: { shortcode: "AAA111", commented: true },
      acts: ["fill", "click"],
    });
  });
});

describe("linkedin acts", () => {
  it("likes a post once", async () => {
    let done = false;
    const { fp, acts } = fakePage({
      text: [""],
      url: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
      present: (h) => (/no reaction\$/.test(String(h.name)) ? !done : done),
      onAct: () => {
        done = true;
      },
    });
    expect(await linkedinLike.run(fp, { urn: "urn:li:activity:1" })).toEqual({
      urn: "urn:li:activity:1",
      liked: true,
    });
    expect(acts).toHaveLength(1);
  });

  it("finds Follow under More for a Connect-first member", async () => {
    let opened = false;
    const { fp, acts } = fakePage({
      text: [""],
      url: "https://www.linkedin.com/in/someone/",
      present: (h) => {
        const css = String(h.css ?? "");
        if (/aria-label="More"/.test(css)) return true;
        if (/div\[role=button\]\[aria-label\^="Follow /.test(css)) return opened;
        return false;
      },
      onAct: () => {
        opened = true;
      },
    });
    expect(await linkedinFollow.run(fp, { vanity: "someone" })).toEqual({ following: true });
    expect(acts).toHaveLength(2);
  });
});
