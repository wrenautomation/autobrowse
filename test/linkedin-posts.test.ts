import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import type { FlowRunner } from "../src/browser/flow.js";
import {
  authorUrlOf,
  companyPostsUrl,
  countOf,
  linkedinCompanyPosts,
  linkedinSearchPosts,
  postOf,
  postsSearchUrl,
  type RawPost,
  READ_POSTS,
} from "../src/browser/flows/linkedin-posts.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { memoryCaps } from "../src/sites/caps.js";
import { siteFacade } from "../src/sites/facade.js";
import { linkedin } from "../src/sites/linkedin.js";
import { fakePage } from "./auth-fakes.js";
import { fakeFetch } from "./fakes.js";

// Synthetic cards and pages; no real people, posts or ids.
const WEB = "https://www.linkedin.com";
const NOW = new Date("2026-10-07T12:00:00.000Z");

const CLASSIC: RawPost = {
  layout: "classic",
  ids: ["urn:li:activity:7001"],
  text: "Test Author\nTest Author • 3rd+\nFounder at Example Staffing\n2h • Edited •\nHiring is slow in Q4.\n1,234\n56 comments",
  links: [`${WEB}/in/test-author?miniProfileUrn=urn%3Ali%3Afs_miniProfile%3Ax`],
  actors: [{ name: "Test Author", url: `${WEB}/in/test-author?miniProfileUrn=abc` }],
  headline: "Founder at Example Staffing",
  sub: "2h • Edited • \n2 hours ago • Edited • Visible to anyone",
  body: "Hiring is slow in Q4.",
  reactions: "1,234",
  comments: "56 comments",
};

const SDUI: RawPost = {
  layout: "sdui",
  ids: ["update-card-focusurn:li:ugcPost:7002FeedType_MAIN_FEED"],
  text: "Feed post\nSample Co\n • Following\n2,345 followers\n3d •\nWe are hiring recruiters.\n2K\n12",
  links: [`${WEB}/company/sample-co/posts/?trk=x`, `${WEB}/company/sample-co/`],
  actors: [{ name: "Sample Co", url: `${WEB}/company/sample-co/posts/?trk=x` }],
  body: "We are hiring recruiters.",
  reactions: "2K",
  comments: "12",
};

describe("linkedin posts: a card", () => {
  it("classic: urn from data-urn, clean author url, headline, age and instant, counts, feed url", () => {
    expect(postOf(CLASSIC, NOW)).toEqual({
      urn: "urn:li:activity:7001",
      author: "Test Author",
      authorUrl: `${WEB}/in/test-author/`,
      headline: "Founder at Example Staffing",
      text: "Hiring is slow in Q4.",
      age: "2h",
      at: "2026-10-07T10:00:00.000Z",
      approx: true,
      reactions: 1234,
      comments: 56,
      url: `${WEB}/feed/update/urn:li:activity:7001/`,
      raw: CLASSIC,
    });
  });

  it("SDUI: urn from a componentkey, company author, headline from the lines, 2K", () => {
    expect(postOf(SDUI, NOW)).toMatchObject({
      urn: "urn:li:ugcPost:7002",
      author: "Sample Co",
      authorUrl: `${WEB}/company/sample-co/`,
      headline: "2,345 followers",
      text: "We are hiring recruiters.",
      age: "3d",
      at: "2026-10-04T12:00:00.000Z",
      reactions: 2000,
      comments: 12,
      url: `${WEB}/feed/update/urn:li:ugcPost:7002/`,
    });
  });

  it("urn from a feed link (encoded too) when no attribute names one; none at all is dropped", () => {
    const linked = { ...SDUI, ids: [], links: [`${WEB}/feed/update/urn:li:share:7003/?x=1`] };
    expect(postOf(linked, NOW)?.urn).toBe("urn:li:share:7003");
    const encoded = { ...SDUI, ids: [], links: [`${WEB}/feed/update/urn%3Ali%3Aactivity%3A7004/`] };
    expect(postOf(encoded, NOW)?.urn).toBe("urn:li:activity:7004");
    // A comment urn is not a post urn.
    const none = { ...SDUI, ids: ["replaceableComment_urn:li:comment:(x,1)"], links: [] };
    expect(postOf(none, NOW)).toBeNull();
  });

  it("a repost's header names the reposter: the author is the next actor", () => {
    const repost: RawPost = {
      ...SDUI,
      text: "Feed post\nOther Person reposted this\nSample Co\n3d •\nWe are hiring recruiters.",
      actors: [
        { name: "Other Person", url: `${WEB}/in/other-person/` },
        { name: "Sample Co", url: `${WEB}/company/sample-co/` },
      ],
    };
    expect(postOf(repost, NOW)).toMatchObject({
      author: "Sample Co",
      authorUrl: `${WEB}/company/sample-co/`,
    });
  });

  it("counts and author urls", () => {
    expect(["1,234", "2K", "1.5M", "12 comments", "", "Comment", undefined].map(countOf)).toEqual([
      1234, 2000, 1500000, 12, 0, 0, 0,
    ]);
    expect(authorUrlOf("https://linkedin.com/in/Some-One-12/recent-activity/?x=1")).toBe(
      `${WEB}/in/Some-One-12/`,
    );
    expect(authorUrlOf(`${WEB}/company/sample-co#about`)).toBe(`${WEB}/company/sample-co/`);
    expect(authorUrlOf(`${WEB}/feed/update/urn:li:activity:1/`)).toBeNull();
    expect(authorUrlOf(undefined)).toBeNull();
  });

  it("urls: search filters quoted and newest first; the company Posts tab", () => {
    expect(postsSearchUrl("staffing agency", "past-24h")).toBe(
      `${WEB}/search/results/content/?keywords=staffing+agency&datePosted=%22past-24h%22&sortBy=%22date_posted%22`,
    );
    expect(companyPostsUrl("sample-co")).toBe(
      `${WEB}/company/sample-co/posts/?feedView=all&sortBy=recent`,
    );
  });
});

/** A results page (absolute links, as `a.href` reads them) with a classic card, an SDUI card, a card with no urn, and a nested card. */
const PAGE = `<main>
<div class="feed-shared-update-v2" data-urn="urn:li:activity:7101">
  <div class="update-components-actor__container">
    <a class="update-components-actor__meta-link" href="https://www.linkedin.com/in/test-author?mini=1">
      <span class="update-components-actor__title"><span aria-hidden="true">Test Author</span> • 3rd+</span>
      <span class="update-components-actor__description">Owner at Example Staffing</span>
      <span class="update-components-actor__sub-description">5h • Edited •</span>
    </a>
  </div>
  <div class="update-components-text">Placements are up this month.</div>
  <span class="social-details-social-counts__reactions-count">1,234</span>
  <button aria-label="Comment">Comment</button>
  <button aria-label="56 comments on Test Author's post">56 comments</button>
  <div class="comments-comments-list"><span data-id="urn:li:activity:9999">a comment</span></div>
</div>
<li componentkey="update-card-focusabc123FeedType_MAIN">
  <h2>Feed post</h2>
  <a href="https://www.linkedin.com/company/sample-co/"></a>
  <a href="https://www.linkedin.com/company/sample-co/posts/">Sample Co</a>
  <div>2,345 followers</div>
  <div>1d •</div>
  <div data-testid="expandable-text-box">We are hiring recruiters.</div>
  <a href="https://www.linkedin.com/feed/update/urn:li:ugcPost:7102/">1d</a>
  <button aria-label="Reaction button state: no reaction">2K</button>
  <button aria-label="Comment">12</button>
</li>
<li componentkey="update-card-focusnourn">
  <h2>Feed post</h2>
  <a href="https://www.linkedin.com/in/no-urn/">No Urn</a>
  <div data-testid="expandable-text-box">A card with no urn.</div>
</li>
</main>`;

describe("linkedin posts: the page script", () => {
  it("is plain JS keyed on the classic and SDUI selectors", () => {
    expect(() => new Function(`return ${READ_POSTS}`)).not.toThrow();
    expect(READ_POSTS).toContain("feed-shared-update-v2");
    expect(READ_POSTS).toContain("update-card-focus");
    expect(READ_POSTS).toContain("expandable-text-box");
    expect(READ_POSTS).not.toMatch(/__name/);
  });

  it("reads synthetic HTML: classic and SDUI cards, comment urns ignored, no-urn card dropped", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      // Offline: the fixture is set as the page's content; nothing is fetched.
      await page.setContent(PAGE);
      const raws = await page.evaluate<RawPost[]>(READ_POSTS);
      expect(raws.map((r) => r.layout)).toEqual(["classic", "sdui", "sdui"]);
      const posts = raws.map((r) => postOf(r, NOW));
      expect(posts[0]).toMatchObject({
        urn: "urn:li:activity:7101",
        author: "Test Author",
        authorUrl: `${WEB}/in/test-author/`,
        headline: "Owner at Example Staffing",
        text: "Placements are up this month.",
        age: "5h",
        reactions: 1234,
        comments: 56,
      });
      expect(posts[1]).toMatchObject({
        urn: "urn:li:ugcPost:7102",
        author: "Sample Co",
        authorUrl: `${WEB}/company/sample-co/`,
        text: "We are hiring recruiters.",
        age: "1d",
        reactions: 2000,
        comments: 12,
      });
      expect(posts[2]).toBeNull();
    } finally {
      await browser.close();
    }
  });
});

describe("linkedin posts: the flows and the routes", () => {
  const scripted = (screens: RawPost[][]) => {
    const { fp, acts } = fakePage({ text: [""], present: (h) => h.name !== "/^don.t allow$/i" });
    const opened: string[] = [];
    fp.open = async (url: string) => {
      opened.push(url);
    };
    let shown = 0;
    fp.scroll = async () => {
      shown++;
    };
    fp.page = {
      evaluate: async (js: string) =>
        js === "innerHeight" ? 800 : (screens[Math.min(shown, screens.length - 1)] ?? []),
    } as unknown as typeof fp.page;
    return { fp, acts, opened };
  };

  it("search: opens the filtered url, keeps each post once, counts no-urn cards once, never acts", async () => {
    const noUrn = { ...SDUI, ids: [], links: [], text: "Feed post\nNo Urn\nSome text" };
    const { fp, acts, opened } = scripted([
      [CLASSIC, noUrn],
      [CLASSIC, SDUI, noUrn],
    ]);
    const out = await linkedinSearchPosts.run(fp, { keywords: "staffing", max: 5 });
    expect(opened).toEqual([postsSearchUrl("staffing", "past-week")]);
    expect(out.posts.map((p) => p.urn)).toEqual(["urn:li:activity:7001", "urn:li:ugcPost:7002"]);
    expect(out.dropped).toBe(1);
    expect(acts).toEqual([]);
  });

  it("company: the Posts tab, max kept", async () => {
    const { fp, opened } = scripted([[CLASSIC, SDUI]]);
    const out = await linkedinCompanyPosts.run(fp, { company: "sample-co", max: 1 });
    expect(opened).toEqual([companyPostsUrl("sample-co")]);
    expect(out.posts.map((p) => p.urn)).toEqual(["urn:li:activity:7001"]);
  });

  it("No results found is no posts; anything else goes to a person", async () => {
    const empty = fakePage({ text: ["No results found"], present: () => false });
    expect(await linkedinSearchPosts.run(empty.fp, { keywords: "x" })).toEqual({
      posts: [],
      dropped: 0,
    });
    const broken = fakePage({ text: ["Something went wrong"], present: () => false });
    await expect(linkedinCompanyPosts.run(broken.fp, { company: "sample-co" })).rejects.toThrow(
      /no post list/,
    );
  });

  it("both flows are registered", () => {
    expect(BROWSER_FLOWS["linkedin/search-posts"]).toBe(linkedinSearchPosts);
    expect(BROWSER_FLOWS["linkedin/company-posts"]).toBe(linkedinCompanyPosts);
  });

  const facade = (runner: FlowRunner, caps = memoryCaps(() => NOW.getTime())) =>
    siteFacade([{ ...linkedin, pace: { gapMs: 0 } }], {
      http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      env: () => undefined,
      sink: memorySink(),
      runner,
      flow: (n) => BROWSER_FLOWS[n] ?? null,
      providerOf: () => null,
      caps,
      accountOf: async (_site, name) => `${name.replace("@", ".")}@x.test`,
    });

  it("routes: defaults and validation, each its flow", async () => {
    const seen: string[] = [];
    const sites = facade({
      async run(flow, input) {
        seen.push(`${flow.name} ${JSON.stringify(input)}`);
        return { posts: [], dropped: 0 } as never;
      },
    });
    const as = "linkedin@wren";
    expect(
      await sites.call("linkedin", "GET", "/search/results/content", { keywords: "ria" }, as),
    ).toEqual({ posts: [], dropped: 0 });
    await sites.call("linkedin", "GET", "/company/sample-co/posts", { max: "5" }, as);
    expect(seen).toEqual([
      'search-posts {"keywords":"ria","max":20,"since":"past-week"}',
      'company-posts {"company":"sample-co","max":5}',
    ]);
    await expect(
      sites.call("linkedin", "GET", "/search/results/content", { keywords: "x", max: 51 }, as),
    ).rejects.toThrow();
    await expect(
      sites.call("linkedin", "GET", "/search/results/content", { keywords: "x", since: "y" }, as),
    ).rejects.toThrow();
  });

  it("the posts cap: 12 a day as linkedin@wren across both routes, off as linkedin and linkedin@alt", async () => {
    expect(linkedin.caps?.posts).toBe(12);
    expect(linkedin.accountCaps?.linkedin?.posts).toBe(0);
    expect(linkedin.accountCaps?.["linkedin@alt"]?.posts).toBe(0);
    const caps = memoryCaps(() => NOW.getTime());
    const sites = facade({ run: async () => ({ posts: [], dropped: 0 }) as never }, caps);
    const search = (who: string) =>
      sites.call("linkedin", "GET", "/search/results/content", { keywords: "ria" }, who);
    for (let i = 0; i < 6; i++) await search("linkedin@wren");
    for (let i = 0; i < 6; i++)
      await sites.call("linkedin", "GET", "/company/sample-co/posts", {}, "linkedin@wren");
    await expect(search("linkedin@wren")).rejects.toMatchObject({ status: 429 });
    await expect(search("linkedin")).rejects.toThrow(/posts reads are off/);
    await expect(search("linkedin@alt")).rejects.toThrow(/posts reads are off/);
    expect(caps.today()["linkedin|linkedin.wren@x.test|posts"]).toBe(12);
  });
});
