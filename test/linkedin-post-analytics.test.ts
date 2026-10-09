import { describe, expect, it } from "vitest";
import type { FlowRunner } from "../src/browser/flow.js";
import {
  analyticsLinkIn,
  countIn,
  linkedinPostAnalytics,
  postAnalyticsOf,
} from "../src/browser/flows/linkedin-post-analytics.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { siteFacade } from "../src/sites/facade.js";
import { linkedin } from "../src/sites/linkedin.js";
import { fakePage } from "./auth-fakes.js";
import { fakeFetch } from "./fakes.js";

// Synthetic page text in the shapes LinkedIn may show it; no real posts or people.
const BEFORE = [
  "Post analytics",
  "Test Member",
  "Discovery",
  "1,204",
  "Impressions",
  "1.2K",
  "Members reached",
  "Profile activity",
  "7",
  "Profile viewers from this post",
  "2",
  "Followers gained from this post",
  "Social engagement",
  "Reactions",
  "12",
  "Comments",
  "3",
  "Reposts",
  "1",
  "Saves",
  "0",
  "Sends on LinkedIn",
  "4",
].join("\n");
const AFTER = [
  "Post analytics",
  "Impressions",
  "980",
  "Members reached",
  "640",
  "Reactions",
  "9",
  "Sends",
  "2",
].join("\n");
const URN = "urn:li:activity:7000000000000000001";

describe("linkedin post analytics: the page text", () => {
  it("reads a count before its label and after it, in one page", () => {
    expect(postAnalyticsOf(BEFORE)).toEqual({
      impressions: 1204,
      reached: 1200,
      reactions: 12,
      comments: 3,
      reposts: 1,
      saves: 0,
      sends: 4,
      profileViewers: 7,
      followersGained: 2,
    });
  });

  it("reads label then count; a missing label is null", () => {
    expect(postAnalyticsOf(AFTER)).toEqual({
      impressions: 980,
      reached: 640,
      reactions: 9,
      comments: null,
      reposts: null,
      saves: null,
      sends: 2,
      profileViewers: null,
      followersGained: null,
    });
  });

  it("reads a count on its label's line; numbers with commas and suffixes", () => {
    const s = postAnalyticsOf("Impressions: 2,500\nReposts 3\n5 Saves");
    expect(s).toMatchObject({ impressions: 2500, reposts: 3, saves: 5, reached: null });
    expect(countIn("1,204")).toBe(1204);
    expect(countIn("1.2K")).toBe(1200);
    expect(countIn("3M")).toBe(3_000_000);
    expect(countIn("12%")).toBeNull();
    expect(postAnalyticsOf("Home\nMy Network\nJobs")).toMatchObject({
      impressions: null,
      reached: null,
    });
  });

  it("finds the post page's analytics link", () => {
    expect(
      analyticsLinkIn(
        '<a href="/feed/">Home</a><a href="/analytics/post-summary/urn:li:activity:7/?a=1&amp;b=2">View analytics</a>',
      ),
    ).toBe("https://www.linkedin.com/analytics/post-summary/urn:li:activity:7/?a=1&b=2");
    expect(analyticsLinkIn('<a href="/feed/">Home</a>')).toBeNull();
  });
});

describe("linkedin post analytics: the flow and the route", () => {
  const pages = (texts: Record<string, string>, html: Record<string, string> = {}) => {
    const { fp, acts } = fakePage({ text: [""], present: (h) => h.name !== "/^don.t allow$/i" });
    const opened: string[] = [];
    fp.open = async (url) => {
      opened.push(url);
    };
    fp.url = () => opened.at(-1) ?? "";
    fp.text = async () => texts[opened.at(-1) ?? ""] ?? "";
    fp.html = async () => html[opened.at(-1) ?? ""] ?? "";
    return { fp, acts, opened };
  };
  const summary = `https://www.linkedin.com/analytics/post-summary/${URN}/`;

  it("reads the analytics page in one load and never acts", async () => {
    const { fp, acts, opened } = pages({ [summary]: AFTER });
    const out = await linkedinPostAnalytics.run(fp, { urn: URN });
    expect(out).toMatchObject({ urn: URN, url: summary, impressions: 980, reached: 640 });
    expect(out.raw).toBe(AFTER);
    expect(opened).toEqual([summary]);
    expect(acts).toEqual([]);
  });

  it("falls back to the post's analytics link; caps the raw text", async () => {
    const share = "urn:li:share:7000000000000000002";
    const post = `https://www.linkedin.com/feed/update/${share}/`;
    const linked = `https://www.linkedin.com/analytics/post-summary/${URN}/`;
    const long = `${BEFORE}\n${"x".repeat(5000)}`;
    const { fp, acts, opened } = pages(
      { [post]: "A post", [linked]: long },
      { [post]: `<a href="/analytics/post-summary/${URN}/">View analytics</a>` },
    );
    const out = await linkedinPostAnalytics.run(fp, { urn: share });
    expect(opened).toEqual([
      `https://www.linkedin.com/analytics/post-summary/${share}/`,
      post,
      linked,
    ]);
    expect(out).toMatchObject({ urn: share, url: linked, impressions: 1204, sends: 4 });
    expect(out.raw).toHaveLength(4000);
    expect(acts).toEqual([]);
  });

  it("goes to a person when no page shows analytics", async () => {
    const share = "urn:li:share:7000000000000000003";
    const post = `https://www.linkedin.com/feed/update/${share}/`;
    const noLink = pages({ [post]: "A post" });
    await expect(linkedinPostAnalytics.run(noLink.fp, { urn: share })).rejects.toThrow(
      /no analytics link/,
    );
    const odd = pages(
      { [post]: "A post", "https://www.linkedin.com/analytics/post-summary/x/": "Home" },
      { [post]: '<a href="/analytics/post-summary/x/">View analytics</a>' },
    );
    await expect(linkedinPostAnalytics.run(odd.fp, { urn: share })).rejects.toThrow(
      /not an analytics page/,
    );
  });

  it("GET /analytics/post-summary/{urn} decodes the urn, runs as linkedin@wren; William's and the alt read none", async () => {
    const seen: string[] = [];
    const runner: FlowRunner = {
      async run(flow, input) {
        seen.push(`${flow.site} ${flow.name} ${JSON.stringify(input)}`);
        return { urn: URN } as never;
      },
    };
    const sites = siteFacade([linkedin], {
      http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      env: () => undefined,
      sink: memorySink(),
      runner,
      flow: (n) => BROWSER_FLOWS[n] ?? null,
      providerOf: () => null,
      accountFor: async () => "hello@wren.test",
      profileFor: async (site) => `${site}@wren`,
    });
    const path = `/analytics/post-summary/${encodeURIComponent(URN)}`;
    expect(path).toContain("%3A");
    expect(await sites.call("linkedin", "GET", path, {})).toEqual({ urn: URN });
    expect(seen).toEqual([`linkedin@wren post-analytics {"urn":"${URN}"}`]);
    await expect(
      sites.call(
        "linkedin",
        "GET",
        `/analytics/post-summary/${encodeURIComponent("urn:li:person:1")}`,
        {},
      ),
    ).rejects.toThrow(/a post urn/);
    expect(BROWSER_FLOWS["linkedin/post-analytics"]).toBe(linkedinPostAnalytics);
    expect(linkedin.caps).toMatchObject({ analytics: 10 });
    expect(linkedin.accountCaps?.linkedin).toMatchObject({ analytics: 0 });
    expect(linkedin.accountCaps?.["linkedin@alt"]).toMatchObject({ analytics: 0 });
    const r = linkedin.routes.find((x) => x.path === "/analytics/post-summary/{urn}");
    expect(r?.meter?.({ urn: URN } as never)).toEqual({ analytics: 1, total: 1 });
  });
});
