import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SITE_LOGINS } from "../src/auth/sites.js";
import type { Ability } from "../src/do/catalog.js";
import { shortlist } from "../src/do/pick.js";
import { defineWorkflow, done } from "../src/index.js";
import {
  find,
  findable,
  sitesOfHost,
  sitesTree,
  type Tool,
  toolkitFor,
  toolsOf,
} from "../src/workflows/toolkit.js";

const wf = (name: string, site: string | undefined, hosts?: string[], description = "test") =>
  defineWorkflow<unknown, Record<string, never>>()({
    name,
    description,
    ...(site ? { site } : {}),
    ...(hosts ? { hosts } : {}),
    plan: z.object({
      dryRun: z.boolean().default(false),
      q: z.string(),
      max: z.number().optional(),
    }),
    steps: [{ name: "open-search-page", run: async () => done("ok") }],
    emptyMemo: () => ({}),
  });

const tools = toolsOf([
  wf("hn-search", "hn", ["hn.algolia.com"], "Recorded 2026-10-25 on hn"),
  wf("linkedin-profile-basics", "linkedin"),
  wf("domain", undefined),
]);

describe("the toolkit", () => {
  it("holds the catalog, then every leg it does not shadow", () => {
    expect(tools.filter((t) => t.name === "hn-search")).toHaveLength(1);
    expect(tools.length).toBeGreaterThan(100);
    const hn = tools.find((t) => t.name === "hn-search") as Tool;
    // a recording's date is no aim: its steps are
    expect(hn).toMatchObject({ site: "hn", aim: "open-search-page", inputs: "q, max?" });
  });

  it("maps a host to its sites: home host, then shared domain, own hosts, a named domain", () => {
    const admin = sitesOfHost("admin.google.com", SITE_LOGINS, tools);
    expect(admin[0]).toBe("google-admin");
    expect(admin).toContain("google");
    expect(sitesOfHost("hn.algolia.com", SITE_LOGINS, tools)).toEqual(["hn"]);
    expect(sitesOfHost("www.loom.com", SITE_LOGINS, tools)).toContain("loom");
    expect(sitesOfHost("example.org", SITE_LOGINS, tools)).toEqual([]);
  });

  it("caps an answer's tools and counts the rest", () => {
    const kit = toolkitFor("www.linkedin.com", SITE_LOGINS, tools, 5);
    const all = tools.filter((t) => t.site === "linkedin").length;
    expect(kit?.tools).toHaveLength(5);
    expect(kit?.more).toBe(all - 5);
    expect(kit?.sites).toEqual(["linkedin"]);
    expect(toolkitFor("example.org", SITE_LOGINS, tools)).toBeNull();
  });

  it("finds through typos; an exact name ranks first", () => {
    const f = tools.map(findable);
    expect(find(f, "linkdin profle").map((t) => t.name)).toContain("linkedin-profile-basics");
    expect(find(f, "hn-search")[0]?.name).toBe("hn-search");
    expect(find(f, "")).toEqual([]);
  });

  it("the tree's root is each site and its count", () => {
    const tree = sitesTree(tools);
    expect(tree).toContainEqual({ site: "hn", tools: 1 });
    expect(tree).toContainEqual({ site: "(any)", tools: 1 });
  });
});

describe("do reads a shortlist", () => {
  const ability = (name: string, summary: string): Ability => ({
    kind: "workflow",
    name,
    site: null,
    summary,
    inputs: [],
    irreversible: false,
    ready: true,
    missing: null,
  });
  const many = [
    ...Array.from({ length: 30 }, (_, i) => ability(`filler-${i}`, "nothing here")),
    ability("youtube-upload", "upload a video to youtube"),
  ];

  it("sends the search's top hits and what the same goal picked before", () => {
    const got = shortlist(
      { goal: "upload my video", earlier: [{ goal: "upload my video", ability: "filler-3" }] },
      many,
    ).map((a) => a.name);
    expect(got[0]).toBe("youtube-upload");
    expect(got).toContain("filler-3");
    expect(got.length).toBeLessThanOrEqual(11);
  });

  it("a goal that finds nothing sends the whole list", () => {
    expect(shortlist({ goal: "zzqx" }, many)).toHaveLength(many.length);
  });
});
