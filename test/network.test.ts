import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import {
  diffHtml,
  diffShapes,
  htmlForFile,
  isPersonalProfile,
  NetLog,
  type NetRow,
  parseRows,
  redactBody,
  redactHeaders,
  redactUrl,
  rowLine,
  secretName,
  shapes,
} from "../src/browser/network.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";

describe("redaction", () => {
  it("names secrets by whole words", () => {
    for (const k of [
      "access_token",
      "X-Api-Key",
      "sessionId",
      "Authorization",
      "fb_dtsg",
      "password",
    ])
      expect(secretName(k), k).toBe(true);
    for (const k of ["keyword", "cardinality", "q", "advertiser", "monkey"])
      expect(secretName(k), k).toBe(false);
  });

  it("keeps a short header list, never a credential", () => {
    expect(
      redactHeaders({
        Authorization: "Bearer abc",
        cookie: "sid=1",
        "content-type": "application/json",
        "x-csrf-token": "t",
        "user-agent": "Chrome",
      }),
    ).toEqual({ "content-type": "application/json" });
  });

  it("masks secret query values and token shapes, keeps the rest", () => {
    const u = new URL(redactUrl(`https://api.test/ads?q=roofing&access_token=abc&next=${JWT}`));
    expect(u.searchParams.get("q")).toBe("roofing");
    expect(u.searchParams.get("access_token")).toBe("<redacted>");
    expect(u.searchParams.get("next")).toBe("<redacted>");
  });

  it("masks JSON under secret keys at any depth, and form fields", () => {
    expect(
      redactBody(
        JSON.stringify({
          user: { name: "Acme", token: "t1", nested: [{ password: "p" }] },
          note: JWT,
        }),
      ),
    ).toEqual({
      user: { name: "Acme", token: "<redacted>", nested: [{ password: "<redacted>" }] },
      note: "<redacted>",
    });
    expect(redactBody("q=roof&fb_dtsg=xyz", "application/x-www-form-urlencoded")).toEqual({
      q: "roof",
      fb_dtsg: "<redacted>",
    });
    expect(redactBody("plain words")).toBe("plain words");
  });

  it("treats a site's bare profile as personal, a labelled one not", () => {
    expect(isPersonalProfile("x", "")).toBe(true);
    expect(isPersonalProfile("linkedin@main", "")).toBe(true);
    expect(isPersonalProfile("x@wren", "")).toBe(false);
    expect(isPersonalProfile("fb-public", "")).toBe(false);
    expect(isPersonalProfile("reddit", "reddit, gmail")).toBe(true);
  });

  it("empties scripts and hidden values out of saved HTML", () => {
    const h = htmlForFile(
      `<html><script>window.t="${JWT}"</script><input type="hidden" name="lsd" value="abc"><p>Hi</p></html>`,
    );
    expect(h).toContain("<script></script>");
    expect(h).toContain('value="<redacted>"');
    expect(h).not.toContain(JWT);
    expect(h).toContain("<p>Hi</p>");
  });
});

describe("shapes and diffs", () => {
  const row = (id: number, url: string, body: unknown): NetRow => ({
    id,
    t: 0,
    method: "GET",
    url,
    status: 200,
    type: "fetch",
    size: 10,
    body,
  });

  it("reduces calls to their path and keys, and diffs two sessions", () => {
    const before = shapes([
      row(1, "https://api.test/ads/123?q=a", { data: [{ id: 1, name: "x" }], paging: {} }),
      row(2, "https://api.test/old", {}),
    ]);
    const after = shapes([
      row(1, "https://api.test/ads/456?q=b", { data: [{ id: 1, title: "x" }] }),
      row(2, "https://api.test/new", { ok: true }),
    ]);
    expect([...before.keys()]).toEqual(["GET api.test/ads/*", "GET api.test/old"]);
    expect(diffShapes(before, after)).toEqual({
      added: ["GET api.test/new"],
      gone: ["GET api.test/old"],
      changed: [
        { call: "GET api.test/ads/*", added: ["data[].title"], gone: ["data[].name", "paging"] },
      ],
    });
  });

  it("writes one line per call and reads a file back, torn lines skipped", () => {
    expect(rowLine(row(3, "https://api.test/ads", { data: [], paging: {} }))).toBe(
      "3 GET 200 api.test/ads 10B {data,paging}",
    );
    const text = `${JSON.stringify(row(1, "https://a.test/x", null))}\n{"id":2,"me`;
    expect(parseRows(text).map((r) => r.id)).toEqual([1]);
  });

  it("diffs HTML by lines", () => {
    expect(diffHtml("<ul><li>a</li><li>b</li></ul>", "<ul><li>a</li><li>c</li></ul>")).toEqual({
      added: ["<li>c</li>"],
      removed: ["<li>b</li>"],
    });
  });
});

describe("NetLog caps", () => {
  /** A fake response: enough of Playwright's for `take`. */
  const res = (n: number) =>
    ({
      request: () => ({
        resourceType: () => "fetch",
        url: () => `https://api.test/${n}`,
        method: () => "GET",
        headers: () => ({}),
        postData: () => null,
      }),
      headers: () => ({ "content-type": "application/json" }),
      status: () => 200,
      text: async () => JSON.stringify({ n, pad: "x ".repeat(40) }),
    }) as unknown as Parameters<NetLog["take"]>[0];

  it("drops the oldest rows, and the bytes they held free room for new bodies", async () => {
    const log = new NetLog({ site: "fb-public", maxRows: 2, maxBodyBytes: 250 });
    for (let n = 1; n <= 5; n++) await log.take(res(n));
    expect(log.rows().map((r) => r.id)).toEqual([4, 5]);
    expect(log.rows().every((r) => r.body !== undefined)).toBe(true);

    const full = new NetLog({ site: "fb-public", maxRows: 10, maxBodyBytes: 150 });
    for (let n = 1; n <= 3; n++) await full.take(res(n));
    expect(full.rows().map((r) => r.body !== undefined)).toEqual([true, true, false]);
  });
});

describe("NetLog on a real browser", () => {
  it("logs fetch calls with redacted bodies; a personal profile keeps only method, path and status", async () => {
    const browser = await chromium.launch();
    try {
      const run = async (site: string) => {
        const context = await browser.newContext();
        const got: NetRow[] = [];
        const log = NetLog.attach(context, { site, onRow: (r) => got.push(r) });
        await context.route("https://api.test/**", (route) =>
          route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({ ads: [{ advertiser: "Acme" }], session: "s3cr3t" }),
          }),
        );
        await context.route("https://site.test/", (route) =>
          route.fulfill({ contentType: "text/html", body: "<p>home</p>" }),
        );
        const page = await context.newPage();
        await page.goto("https://site.test/");
        await page.evaluate(() =>
          fetch("https://api.test/ads?q=roof&token=abc", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer zzz" },
            body: JSON.stringify({ q: "roof", password: "pw" }),
          }).then((r) => r.json()),
        );
        await expect.poll(() => got.length).toBe(2);
        await context.close();
        return log;
      };

      const log = await run("fb-public");
      const [doc, call] = log.rows();
      expect(doc).toMatchObject({ method: "GET", type: "document", url: "https://site.test/" });
      expect(doc?.body).toBeUndefined();
      expect(call).toMatchObject({
        method: "POST",
        status: 200,
        url: "https://api.test/ads?q=roof&token=%3Credacted%3E",
        reqHeaders: { "content-type": "application/json" },
        reqBody: { q: "roof", password: "<redacted>" },
        body: { ads: [{ advertiser: "Acme" }], session: "<redacted>" },
      });
      expect(log.jsonl()).not.toMatch(/zzz|s3cr3t|"pw"|token=abc/);

      const mine = await run("x");
      expect(mine.rows()[1]).toEqual({
        id: 2,
        t: expect.any(Number),
        method: "POST",
        url: "https://api.test/ads",
        status: 200,
        type: "fetch",
        size: expect.any(Number),
      });
    } finally {
      await browser.close();
    }
  });
});

describe("a failed flow", () => {
  it("writes its page calls and HTML beside the PNG, and names them in the failure record", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { defineFlow, flowRunner, FlowFailed } = await import("../src/browser/flow.js");
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-net-fail-"));
    const runner = flowRunner(
      {
        tier: "local",
        channel: "chromium",
        profilesDir: join(dir, "profiles"),
        artifactsDir: join(dir, "artifacts"),
        headless: true,
      },
      { pace: null },
    );
    const page = `data:text/html,${encodeURIComponent(`<p>hi</p><script>var t=1</script>`)}`;
    const broke = defineFlow<undefined, void>({
      site: "fb-public",
      name: "broke",
      async run(fp) {
        await fp.page.route("https://api.test/**", (r) =>
          r.fulfill({ contentType: "application/json", body: '{"ads":[],"token":"t1"}' }),
        );
        await fp.open(page);
        await fp.page.evaluate(() => fetch("https://api.test/ads").then((r) => r.text()));
        await expect.poll(() => fp.network?.rows().length).toBe(1);
        throw new Error("no ads");
      },
    });
    const err = await runner.run(broke, undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowFailed);
    const { artifacts } = err as InstanceType<typeof FlowFailed>;
    expect(readFileSync(artifacts.network ?? "", "utf8")).toContain('"token":"<redacted>"');
    expect(readFileSync(artifacts.html ?? "", "utf8")).toContain("<script></script>");
    const record = JSON.parse(readFileSync(artifacts.failure ?? "", "utf8"));
    expect(record).toMatchObject({ network: artifacts.network, html: artifacts.html });
  }, 60_000);
});
