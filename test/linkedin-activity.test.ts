import { describe, expect, it } from "vitest";
import type { FlowRunner } from "../src/browser/flow.js";
import {
  activityOf,
  linkedinActivity,
  type RawActivity,
} from "../src/browser/flows/linkedin-activity.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { memoryCaps } from "../src/sites/caps.js";
import { siteFacade } from "../src/sites/facade.js";
import { linkedin } from "../src/sites/linkedin.js";
import { fakePage } from "./auth-fakes.js";
import { fakeFetch } from "./fakes.js";

// Synthetic cards in the shape the page script returns; no real people or posts.
const FEED = "https://www.linkedin.com/feed/update/";
const card = (urn: string, text: string, more: Partial<RawActivity> = {}): RawActivity => ({
  urn,
  text,
  links: [`https://www.linkedin.com/in/test-person/`],
  ...more,
});
const CARDS: RawActivity[] = [
  card(
    "urn:li:activity:2001",
    "Test Person\nOwner at Example Staffing\n2w • Edited •\nHiring is slow in Q4. Here is what we changed.\n…more\n52\n12 comments\nLike\nComment\nRepost\nSend",
    { body: "Hiring is slow in Q4. Here is what we changed." },
  ),
  card(
    "urn:li:activity:2002",
    "Test Person reposted this\nOther Author\nFounder at Sample Co\n3mo •\nA long post about placements and fees.\nOther Author and 7 others\n2 comments",
  ),
  card(
    "urn:li:activity:2003",
    "Test Person commented on this\nOther Author\n1d •\nA question about agency fees.\nTest Person\nWe charge a flat fee.\n1,204 reactions",
    {
      body: "A question about agency fees.",
      comment: "We charge a flat fee.",
      links: [
        `${FEED}urn:li:activity:2003?commentUrn=urn%3Ali%3Acomment%3A(activity%3A2003%2C9001)`,
      ],
    },
  ),
  card(
    "urn:li:activity:2004",
    "Test Person likes this\nOther Author\n4d •\nSomeone else's post.\n9",
  ),
];
const NOW = new Date("2026-10-06T12:00:00.000Z");

describe("linkedin activity: a card", () => {
  it("a post: urn, text, age and its instant, counts, url, raw", () => {
    expect(activityOf(CARDS[0] as RawActivity, NOW)).toEqual({
      urn: "urn:li:activity:2001",
      kind: "post",
      text: "Hiring is slow in Q4. Here is what we changed.",
      age: "2w",
      at: "2026-09-22T12:00:00.000Z",
      approx: true,
      reactions: 52,
      comments: 12,
      url: `${FEED}urn:li:activity:2001/`,
      raw: CARDS[0],
    });
  });

  it("a repost and a comment by their headers; a comment keeps its own urn; a reaction is no item", () => {
    const [, repost, comment, like] = CARDS.map((c) => activityOf(c, NOW));
    expect(repost).toMatchObject({
      kind: "repost",
      text: "A long post about placements and fees.",
      age: "3mo",
      reactions: 8,
      comments: 2,
    });
    expect(comment).toMatchObject({
      urn: "urn:li:comment:(activity:2003,9001)",
      kind: "comment",
      text: "We charge a flat fee.",
      age: "1d",
      reactions: 1204,
      url: `${FEED}urn:li:activity:2003/`,
    });
    expect(like).toBeNull();
  });

  it("no urn or no age: no item, or an item with no time", () => {
    expect(activityOf({ ...(CARDS[0] as RawActivity), urn: "" }, NOW)).toBeNull();
    const undated = activityOf(card("urn:li:activity:5", "Just words here"), NOW);
    expect(undated).toMatchObject({ kind: "post", text: "Just words here" });
    expect(undated?.at).toBeUndefined();
  });
});

describe("linkedin activity: the flow and the route", () => {
  it("scrolls until max, each item once, and never acts", async () => {
    const { fp, acts } = fakePage({ text: [""], present: (h) => h.name !== "/^don.t allow$/i" });
    const screens = [CARDS.slice(0, 2), CARDS.slice(1, 4)];
    let shown = 0;
    fp.scroll = async () => {
      shown++;
    };
    fp.page = {
      evaluate: async (fn: unknown) =>
        typeof fn === "string" ? 800 : (screens[Math.min(shown, screens.length - 1)] ?? []),
    } as unknown as typeof fp.page;
    const out = await linkedinActivity.run(fp, { vanity: "test-person", max: 3 });
    expect(out.activity.map((a) => a.kind)).toEqual(["post", "repost", "comment"]);
    expect(acts).toEqual([]);
  });

  it("an empty page is no activity; no list and no empty note goes to a person", async () => {
    const empty = fakePage({ text: ["Test Person hasn't posted yet"], present: () => false });
    expect(await linkedinActivity.run(empty.fp, { vanity: "test-person" })).toEqual({
      activity: [],
    });
    const broken = fakePage({ text: ["Something went wrong"], present: () => false });
    await expect(linkedinActivity.run(broken.fp, { vanity: "test-person" })).rejects.toThrow(
      /no activity list/,
    );
  });

  it("GET /in/{vanity}/activity: max 20 by default, metered activity, 10 a day on linkedin@alt only", async () => {
    const seen: string[] = [];
    const runner: FlowRunner = {
      async run(flow, input) {
        seen.push(`${flow.site} ${flow.name} ${JSON.stringify(input)}`);
        return { activity: [] } as never;
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
      profileFor: async (site) => `${site}@alt`,
    });
    expect(await sites.call("linkedin", "GET", "/in/test-person/activity", {})).toEqual({
      activity: [],
    });
    expect(seen).toEqual(['linkedin@alt activity {"vanity":"test-person","max":20}']);
  });

  it("as the site's own login, the flow runs where that login's session lives (provider)", async () => {
    const seen: Array<string | undefined> = [];
    const sites = siteFacade([{ ...linkedin, pace: { gapMs: 0 } }], {
      http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      env: () => undefined,
      sink: memorySink(),
      runner: {
        async run(flow) {
          seen.push(`${flow.site} ${flow.profile ?? "-"}`);
          return { activity: [] } as never;
        },
      },
      flow: (n) => BROWSER_FLOWS[n] ?? null,
      providerOf: () => null,
      profileFor: async (site, account) => (account === "main@x.test" ? site : `${site}@alt`),
    });
    await sites.call("linkedin", "GET", "/in/test-person/activity", {}, "main@x.test");
    await sites.call("linkedin", "GET", "/in/test-person/activity", {}, "alt@x.test");
    expect(seen).toEqual(["linkedin provider", "linkedin@alt -"]);
  });

  it("the activity cap: 10 a day as linkedin@alt and linkedin (his main), off as linkedin@wren", async () => {
    const caps = memoryCaps(() => NOW.getTime());
    const sites = siteFacade([{ ...linkedin, pace: { gapMs: 0 } }], {
      http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      env: () => undefined,
      sink: memorySink(),
      runner: { run: async () => ({ activity: [] }) as never },
      flow: (n) => BROWSER_FLOWS[n] ?? null,
      providerOf: () => null,
      caps,
      accountOf: async (_site, name) => `${name.replace("@", ".")}@x.test`,
    });
    const read = (who: string) =>
      sites.call("linkedin", "GET", "/in/test-person/activity", {}, who);
    for (let i = 0; i < 10; i++) await read("linkedin@alt");
    await expect(read("linkedin@alt")).rejects.toMatchObject({ status: 429 });
    for (let i = 0; i < 10; i++) await read("linkedin");
    await expect(read("linkedin")).rejects.toMatchObject({ status: 429 });
    await expect(read("linkedin@wren")).rejects.toThrow(/activity reads are off/);
    expect(caps.today()["linkedin|linkedin.alt@x.test|activity"]).toBe(10);
  });
});
