import { describe, expect, it } from "vitest";
import type { FlowRunner } from "../src/browser/flow.js";
import { countOf, linkedinAudience, WREN_PAGE } from "../src/browser/flows/linkedin-audience.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { siteFacade } from "../src/sites/facade.js";
import { linkedin } from "../src/sites/linkedin.js";
import { fakePage } from "./auth-fakes.js";
import { fakeFetch } from "./fakes.js";

// Synthetic page text in the shape LinkedIn shows it; no real people.
const PROFILE =
  "Test Member\nFounder at Test Co\nNew York, United States\nContact info\n57 followers\n48 connections\nOpen to\nActivity\n57 followers";
const PAGE =
  "Test Co\nIT Services and IT Consulting · New York · 1,204 followers · 2-10 employees\nFollow";

describe("linkedin audience: counts", () => {
  it("reads commas, a floor and a suffix as the page says them", () => {
    expect(countOf(PAGE, "followers")).toEqual({ n: 1204, label: "1,204" });
    expect(countOf("500+ connections", "connections")).toEqual({ n: 500, label: "500+" });
    expect(countOf("12K followers", "followers")).toEqual({ n: 12_000, label: "12K" });
    expect(countOf("1.2K followers", "followers")).toEqual({ n: 1200, label: "1.2K" });
    expect(countOf("Follow\nMessage", "followers")).toBeNull();
  });
});

describe("linkedin audience: the flow and the route", () => {
  const pages = (texts: Record<string, string>) => {
    const { fp, acts } = fakePage({ text: [""], present: (h) => h.name !== "/^don.t allow$/i" });
    const opened: string[] = [];
    fp.open = async (url) => {
      opened.push(url);
    };
    fp.text = async () => texts[opened.at(-1) ?? ""] ?? "";
    return { fp, acts, opened };
  };

  it("reads its own profile, then Wren's Page; never acts", async () => {
    const { fp, acts, opened } = pages({
      "https://www.linkedin.com/in/me/": PROFILE,
      [`https://www.linkedin.com/company/${WREN_PAGE}/`]: PAGE,
    });
    const out = await linkedinAudience.run(fp, {});
    expect(out).toEqual({
      followers: 57,
      connections: { n: 48, label: "48" },
      page: { id: WREN_PAGE, followers: 1204, label: "1,204" },
      raw: { profile: PROFILE, page: PAGE },
    });
    expect(opened).toEqual([
      "https://www.linkedin.com/in/me/",
      `https://www.linkedin.com/company/${WREN_PAGE}/`,
    ]);
    expect(acts).toEqual([]);
  });

  it("an empty page skips the Page; a profile with no count goes to a person", async () => {
    const { fp, opened } = pages({ "https://www.linkedin.com/in/me/": PROFILE });
    expect((await linkedinAudience.run(fp, { page: "" })).page).toBeUndefined();
    expect(opened).toHaveLength(1);
    const bare = pages({ "https://www.linkedin.com/in/me/": "Test Member\nContact info" });
    await expect(linkedinAudience.run(bare.fp, {})).rejects.toThrow(/no follower count/);
  });

  it("GET /audience runs as linkedin@wren, metered 4 a day; William's and the alt read none", async () => {
    const seen: string[] = [];
    const runner: FlowRunner = {
      async run(flow, input) {
        seen.push(`${flow.site} ${flow.name} ${JSON.stringify(input)}`);
        return { followers: 1 } as never;
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
    expect(await sites.call("linkedin", "GET", "/audience", {})).toEqual({ followers: 1 });
    expect(seen).toEqual(["linkedin@wren audience {}"]);
    await expect(sites.call("linkedin", "GET", "/audience", { page: "a/b" })).rejects.toThrow();
    expect(linkedin.caps).toMatchObject({ audience: 4 });
    expect(linkedin.accountCaps?.linkedin).toMatchObject({ audience: 0 });
    expect(linkedin.accountCaps?.["linkedin@alt"]).toMatchObject({ audience: 0 });
  });
});
