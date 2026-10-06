import { describe, expect, it } from "vitest";
import type { FlowRunner } from "../src/browser/flow.js";
import {
  type Activity,
  activityOf,
  linkedinActivity,
  newestFirst,
  type RawActivity,
  readCards,
} from "../src/browser/flows/linkedin-activity.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { memoryCaps } from "../src/sites/caps.js";
import { siteFacade } from "../src/sites/facade.js";
import { linkedin } from "../src/sites/linkedin.js";
import { fakePage } from "./auth-fakes.js";
import { fakeFetch } from "./fakes.js";

// Synthetic cards in the shape the page script returns (SDUI layout, mapped
// 2026-10-06); no real people, posts or ids.
const FEED = "https://www.linkedin.com/feed/update/";
const ME = "test-person";
const card = (key: string, text: string, more: Partial<RawActivity> = {}): RawActivity => ({
  key,
  text,
  links: [`https://www.linkedin.com/in/${ME}/`],
  reactions: 0,
  comments: 0,
  ...more,
});
const POST = card(
  "hashPost",
  "Feed post\nTest Person\n • 3rd+\nOwner at Example Staffing\n2w • Edited •\nHiring is slow in Q4. Here is what we changed.\n… more\n52\n12\n3",
  { body: "Hiring is slow in Q4. Here is what we changed.", reactions: 52, comments: 12 },
);
const REPOST = card(
  "hashRepost",
  "Feed post\nTest Person reposted this\nOther Author\n • 3rd+\nFounder at Sample Co\n3mo •\nA long post about placements and fees.\n8\n2",
  {
    body: "A long post about placements and fees.",
    reactions: 8,
    comments: 2,
    links: [`${FEED}urn:li:activity:2002/`],
  },
);
const COMMENT = card(
  "hashComment",
  "Feed post\nTest Person commented\nOther Author\n1d •\nA question about agency fees.\n1,204\n30\nTest Person\n • You\nWe charge a flat fee.\n5h",
  {
    body: "A question about agency fees.",
    reactions: 1204,
    comments: 30,
    comment: {
      urn: "urn:li:comment:(activity:2003,9001)",
      age: "5h",
      text: "We charge a flat fee.",
      reactions: 2,
      replies: 1,
    },
  },
);
const LIKE = card(
  "hashLike",
  "Feed post\nTest Person likes this\nOther Author\n4d •\nSomeone else's post.",
  {
    body: "Someone else's post.",
  },
);
const NOW = new Date("2026-10-06T12:00:00.000Z");
const of = (r: RawActivity) => activityOf(r, NOW, ME);

describe("linkedin activity: a card", () => {
  it("a post: card-hash urn, body, age and its instant, button counts, activity-page url", () => {
    expect(of(POST)).toEqual({
      urn: "urn:li:card:hashPost",
      kind: "post",
      text: "Hiring is slow in Q4. Here is what we changed.",
      age: "2w",
      at: "2026-09-22T12:00:00.000Z",
      approx: true,
      reactions: 52,
      comments: 12,
      url: `https://www.linkedin.com/in/${ME}/recent-activity/all/`,
      raw: POST,
    });
  });

  it("a repost takes its linked urn; a comment its own urn, age and counts; a reaction is no item", () => {
    expect(of(REPOST)).toMatchObject({
      urn: "urn:li:activity:2002",
      kind: "repost",
      text: "A long post about placements and fees.",
      age: "3mo",
      url: `${FEED}urn:li:activity:2002/`,
    });
    expect(of({ ...REPOST, links: [] })?.urn).toBe("urn:li:card:hashRepost");
    expect(of(COMMENT)).toMatchObject({
      urn: "urn:li:comment:(activity:2003,9001)",
      kind: "comment",
      text: "We charge a flat fee.",
      age: "5h",
      at: "2026-10-06T07:00:00.000Z",
      reactions: 2,
      comments: 1,
      url: `${FEED}urn:li:activity:2003/`,
    });
    expect(of(LIKE)).toBeNull();
  });

  it("no key, no text, or a comment card without theirs: no item", () => {
    expect(of({ ...POST, key: "" })).toBeNull();
    expect(of({ ...POST, body: undefined })).toBeNull();
    const { comment: _, ...noComment } = COMMENT;
    expect(of(noComment)).toBeNull();
  });

  it("both tabs merge newest first, max kept, undated last", () => {
    const [post, repost, comment] = [POST, REPOST, COMMENT].map(of) as Activity[];
    const undated = { ...(post as Activity), urn: "x", at: undefined };
    expect(
      newestFirst([[post, repost, undated] as Activity[], [comment as Activity]], 3).map(
        (a) => a.kind,
      ),
    ).toEqual(["comment", "post", "repost"]);
  });

  it("the page script is plain JS that keys on componentkey, test ids and aria-labels", () => {
    const js = readCards(ME);
    expect(() => new Function(`return ${js}`)).not.toThrow();
    expect(js).toContain("update-card-focus");
    expect(js).toContain("replaceableComment_urn:li:comment:");
    expect(js).toContain(`/in/${ME}/`);
    expect(js).not.toMatch(/__name/);
  });
});

describe("linkedin activity: the flow and the route", () => {
  it("reads the all tab then the comments tab, each item once, merged newest first, never acts", async () => {
    const { fp, acts } = fakePage({ text: [""], present: (h) => h.name !== "/^don.t allow$/i" });
    const opened: string[] = [];
    fp.open = async (url: string) => {
      opened.push(url.replace(/^.*recent-activity\//, ""));
    };
    const tabs: Record<string, RawActivity[][]> = {
      "all/": [
        [POST, REPOST],
        [REPOST, LIKE, COMMENT],
      ],
      "comments/": [[COMMENT]],
    };
    let shown = 0;
    fp.scroll = async () => {
      shown++;
    };
    fp.page = {
      evaluate: async (js: string) => {
        if (js === "innerHeight") return 800;
        const screens = tabs[opened.at(-1) ?? ""] ?? [];
        return screens[Math.min(shown, screens.length - 1)] ?? [];
      },
    } as unknown as typeof fp.page;
    const out = await linkedinActivity.run(fp, { vanity: ME, max: 3 });
    expect(opened).toEqual(["all/", "comments/"]);
    expect(out.activity.map((a) => a.kind)).toEqual(["comment", "post", "repost"]);
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
