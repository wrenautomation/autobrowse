import { describe, expect, it } from "vitest";
import {
  DASHBOARD_URL,
  dashboardOf,
  linkedinDashboard,
} from "../src/browser/flows/linkedin-dashboard.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { memoryCaps } from "../src/sites/caps.js";
import { siteFacade } from "../src/sites/facade.js";
import { linkedin } from "../src/sites/linkedin.js";
import { fakePage } from "./auth-fakes.js";
import { fakeBrowser, fakeFetch } from "./fakes.js";

// Synthetic dashboard text in the shapes LinkedIn may show it; no real account.
const ABOVE = [
  "Your Dashboard",
  "Private to you",
  "1,204",
  "Post impressions",
  "Past 7 days",
  "45",
  "Profile viewers",
  "Past 90 days",
  "12",
  "Search appearances",
  "Previous week",
  "1.2K",
  "Followers",
].join("\n");
const BELOW = [
  "Analytics",
  "Private to you",
  "Profile viewers",
  "Past 90 days",
  "45",
  "Search appearances",
  "Previous week",
  "12",
  "Post impressions",
  "980",
].join("\n");
const noon = Date.UTC(2026, 8, 29, 12);

describe("linkedin dashboard: the page text", () => {
  it("reads a count above its label, with each count's window", () => {
    expect(dashboardOf(ABOVE)).toEqual({
      profileViewers: 45,
      searchAppearances: 12,
      postImpressions: 1204,
      followers: 1200,
      windows: {
        profileViewers: "Past 90 days",
        searchAppearances: "Previous week",
        postImpressions: "Past 7 days",
        followers: null,
      },
    });
  });

  it("reads a label above its count, the window between; a missing label is null", () => {
    expect(dashboardOf(BELOW)).toEqual({
      profileViewers: 45,
      searchAppearances: 12,
      postImpressions: 980,
      followers: null,
      windows: {
        profileViewers: "Past 90 days",
        searchAppearances: "Previous week",
        postImpressions: null,
        followers: null,
      },
    });
  });

  it("reads a count on its label's line", () => {
    const s = dashboardOf(
      "Profile viewers: 45\nPast 90 days\n12 search appearances\nFollowers 1.2K\n3M post impressions",
    );
    expect(s).toMatchObject({
      profileViewers: 45,
      searchAppearances: 12,
      followers: 1200,
      postImpressions: 3_000_000,
    });
    expect(s.windows.profileViewers).toBe("Past 90 days");
    expect(dashboardOf("Home\nMy Network\nGrow your followers")).toMatchObject({
      profileViewers: null,
      searchAppearances: null,
      followers: null,
    });
  });
});

describe("linkedin dashboard: the flow and the route", () => {
  const page = (text: string) => {
    const { fp, acts } = fakePage({ text: [text], present: (h) => h.name !== "/^don.t allow$/i" });
    const opened: string[] = [];
    fp.open = async (url) => {
      opened.push(url);
    };
    fp.url = () => opened.at(-1) ?? "";
    return { fp, acts, opened };
  };

  it("reads the dashboard in one load and never acts; caps the raw text", async () => {
    const long = `${ABOVE}\n${"x".repeat(5000)}`;
    const { fp, acts, opened } = page(long);
    const out = await linkedinDashboard.run(fp, {});
    expect(out).toMatchObject({
      profileViewers: 45,
      searchAppearances: 12,
      postImpressions: 1204,
      followers: 1200,
      url: DASHBOARD_URL,
    });
    expect(out.raw).toHaveLength(4000);
    expect(opened).toEqual([DASHBOARD_URL]);
    expect(acts).toEqual([]);
  });

  it("goes to a person when the page shows neither viewers nor appearances", async () => {
    const { fp } = page("Home\n980\nPost impressions");
    await expect(linkedinDashboard.run(fp, {})).rejects.toThrow(
      /neither profile viewers nor search appearances/,
    );
  });

  it("GET /analytics/dashboard runs as linkedin@wren under the analytics cap; William's and the alt read none", async () => {
    const seen: string[] = [];
    const browser = fakeBrowser([]);
    browser.on(linkedinDashboard, async (i) => {
      seen.push(JSON.stringify(i));
      return { profileViewers: 45 } as never;
    });
    const caps = memoryCaps(() => noon);
    const sites = siteFacade([{ ...linkedin, pace: { gapMs: 0 } }], {
      http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      env: () => undefined,
      sink: memorySink(),
      runner: browser,
      flow: (n) => BROWSER_FLOWS[n] ?? null,
      caps,
      accountOf: async (_site, name) =>
        ({ linkedin: "me@x.test", "linkedin@alt": "alt@x.test", "linkedin@wren": "w@x.test" })[
          name
        ] ?? null,
    });
    const read = (who: string) => sites.call("linkedin", "GET", "/analytics/dashboard", {}, who);
    for (let i = 0; i < 10; i++)
      expect(await read("linkedin@wren")).toEqual({ profileViewers: 45 });
    await expect(read("linkedin@wren")).rejects.toMatchObject({ status: 429 });
    await expect(read("linkedin")).rejects.toMatchObject({ status: 429 });
    await expect(read("linkedin@alt")).rejects.toMatchObject({ status: 429 });
    expect(seen).toEqual(Array(10).fill("{}"));
    expect(caps.today()["linkedin|w@x.test|analytics"]).toBe(10);
    expect(BROWSER_FLOWS["linkedin/dashboard"]).toBe(linkedinDashboard);
    const r = linkedin.routes.find((x) => x.path === "/analytics/dashboard");
    expect(r?.meter?.({} as never)).toEqual({ analytics: 1, total: 1 });
  });
});
