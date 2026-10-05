import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { missedSample, writeRecords } from "../src/agent/records.js";
import { fieldsOf, metaSignedIn } from "../src/app/cli-runs.js";
import type { FlowPage } from "../src/browser/flow.js";
import { checkRows, runExtractor, snapshot } from "../src/browser/records.js";
import { fakeLlm } from "../src/llm/fake.js";

const PAGE = `<html><head><title>Ads</title><script>document.title = "ran"</script></head><body>
  <div class="feed">
    <div class="x1a"><span>Acme Staffing</span><p>We are hiring nurses</p><a href="/ads/?id=11">Details</a></div>
    <div class="x1a"><span>Globex Talent</span><p>Recruiters wanted</p><a href="/ads/?id=12">Details</a></div>
    <div class="x1a"><span>Initech Search</span><p>Join us</p><a href="/ads/?id=13">Details</a></div>
  </div></body></html>`;
const URL_ = "https://lib.test/ads/?q=staffing";
const fields = [
  { key: "advertiser", says: "who runs it" },
  { key: "text", says: "the ad text" },
  { key: "link", says: "its page", optional: true },
];
const page = { content: async () => PAGE, url: () => URL_ } as unknown as Page;
const fp = {
  page,
  url: () => URL_,
  text: async () =>
    "Acme Staffing We are hiring nurses Globex Talent Recruiters wanted Initech Search Join us",
} as unknown as FlowPage;
const GOOD = `return [...root.querySelectorAll(".feed > div")].map((d) => ({
  advertiser: d.querySelector("span").textContent, text: d.querySelector("p").textContent,
  link: d.querySelector("a").href }));`;

describe("the records sandbox", () => {
  it("runs the code on the copied markup, page scripts out, links resolved", async () => {
    const html = await snapshot(page);
    expect(html).not.toContain("<script");
    const rows = await runExtractor(html, { code: GOOD, fields });
    expect(rows[0]).toEqual({
      advertiser: "Acme Staffing",
      text: "We are hiring nurses",
      link: "https://lib.test/ads/?id=11",
    });
    expect(rows).toHaveLength(3);
  });

  it("has no network, and says when the code returns no array", async () => {
    const send = `const r = new XMLHttpRequest(); r.open("GET", "https://example.com/x", false);
      try { r.send(); return [{ advertiser: "sent" }]; } catch { return [{ advertiser: "blocked" }]; }`;
    const html = await snapshot(page);
    expect(await runExtractor(html, { code: send, fields })).toEqual([
      { advertiser: "blocked", text: null, link: null },
    ]);
    await expect(runExtractor(html, { code: "return 3;", fields })).rejects.toThrow(
      /returned number/,
    );
  });
});

describe("checkRows and missedSample", () => {
  it("wants rows, the floor, and required fields mostly filled", () => {
    const row = (advertiser: string | null) => ({ advertiser, text: "t", link: null });
    expect(checkRows([], { fields, min: 1 })).toBe("no rows");
    expect(checkRows([row("a")], { fields, min: 3 })).toMatch(/1 rows, fewer than the 3/);
    expect(checkRows([row("a"), row(null)], { fields, min: 1 })).toMatch(
      /advertiser is empty on 1 of 2/,
    );
    expect(checkRows([row("a"), row("b")], { fields, min: 2 })).toBeNull();
  });

  it("matches the eye's rows either way round, ignoring case and punctuation", () => {
    const rows = [{ advertiser: "ACME Staffing, LLC", text: "We are hiring" }];
    expect(missedSample(rows, [{ advertiser: "Acme Staffing", text: null }])).toEqual([]);
    expect(missedSample(rows, [{ advertiser: "Globex", text: null }])).toHaveLength(1);
  });
});

describe("writeRecords", () => {
  it("feeds a failed check back and keeps the code that passes", async () => {
    const llm = fakeLlm([
      {
        rows: [
          { advertiser: "Acme Staffing", text: "We are hiring nurses" },
          { advertiser: "Initech Search", text: "Join us" },
        ],
      },
      {
        code: `return [...root.querySelectorAll("span")].map((s) => ({ advertiser: "Acme Staffing", text: s.textContent }));`,
      },
      { code: GOOD },
    ]);
    const w = await writeRecords({ fp, llm, goal: "ads", as: "ads", fields, key: "link" });
    if ("error" in w) throw new Error(w.error);
    expect(w.op).toMatchObject({ kind: "records", code: GOOD, min: 1, key: "link" });
    expect(w.op.sample).toHaveLength(2);
    expect(w.rows).toHaveLength(3);
    // The first code's rows all share one link key (null): one row, and the eye's Initech row is missing.
    expect(llm.requests[2]?.prompt).toMatch(/It failed: .*Initech Search/);
  });

  it("stops when the eye sees no rows", async () => {
    const w = await writeRecords({
      fp,
      llm: fakeLlm([{ rows: [] }]),
      goal: "ads",
      as: "ads",
      fields,
      key: "link",
    });
    expect(w).toMatchObject({ error: "the page shows no rows of these fields" });
  });
});

describe("records CLI parts", () => {
  it("parses fields, ? marks an often-empty one", () => {
    expect(fieldsOf("advertiser:who runs it, link?:its page")).toEqual([
      { key: "advertiser", says: "who runs it" },
      { key: "link", says: "its page", optional: true },
    ]);
    expect(() => fieldsOf("Bad Key:x")).toThrow(/camelCase/);
  });

  it("refuses a Meta page under a site that signs in", () => {
    expect(metaSignedIn("facebook", "https://www.facebook.com/ads/library/?q={q}", undefined)).toBe(
      true,
    );
    expect(
      metaSignedIn("fb-public", "https://www.facebook.com/ads/library/?q={q}", undefined),
    ).toBe(false);
    expect(metaSignedIn("fb-public", "https://www.facebook.com/groups/x", "fb-public")).toBe(true);
    expect(metaSignedIn("facebook", "https://example.com/list", undefined)).toBe(false);
  });
});
