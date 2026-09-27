import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fileFixes, memoryFixes } from "../src/browser/fixes.js";
import { defineFlow, flowRunner } from "../src/browser/flow.js";
import type { Repairer } from "../src/browser/repair.js";

describe("fixes", () => {
  it("keeps a working repair by flow, goal and broken hints; drops and forgets", () => {
    const fixes = memoryFixes();
    const report = {
      site: "x@wren",
      flow: "x@wren/login",
      goal: "click Next",
      failed: { role: "button", name: "Next" },
      hints: { role: "button", name: "Continue" },
      reason: "renamed",
      url: "https://x.com/i/flow/login",
    };
    fixes.learn({ ...report, ok: false });
    expect(fixes.list()).toEqual([]);
    fixes.learn({ ...report, ok: true });
    // Kept under the base site: every account's run shares it.
    expect(fixes.find("x/login", "click Next", report.failed)).toEqual({
      hints: report.hints,
      detours: [],
    });
    fixes.used("x/login", "click Next", report.failed);
    expect(fixes.list()[0]?.used).toBe(1);
    fixes.drop("x/login", "click Next", report.failed);
    expect(fixes.find("x/login", "click Next", report.failed)).toBeNull();
    fixes.learn({ ...report, ok: true });
    expect(fixes.forget("x/login")).toBe(1);
    expect(fixes.list()).toEqual([]);
  });

  const server = createServer((q, r) =>
    r.writeHead(200, { "content-type": "text/html" }).end(
      q.url === "/screen"
        ? // A new screen in the way: "Pay now" shows only after "Continue".
          "<title>t</title><button onclick=\"this.remove();document.getElementById('p').hidden=false\">Continue</button><button id=p hidden onclick=\"document.title='paid'\">Pay now</button>"
        : "<title>t</title><button onclick=\"document.title='paid'\">Pay now</button>",
    ),
  );
  const ready = new Promise<string>((ok) =>
    server.listen(0, "127.0.0.1", () =>
      ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`),
    ),
  );
  afterAll(() => server.close());

  it("the next run goes straight to the kept fix: no model, no wait on the stale hints", async () => {
    const url = await ready;
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-fixes-"));
    const fixes = fileFixes(join(dir, "fixes.json"));
    let asked = 0;
    const repairer: Repairer = {
      id: "count",
      async propose() {
        asked += 1;
        return { hints: { role: "button", name: "Pay now" }, reason: "renamed" };
      },
    };
    const runner = flowRunner(
      {
        tier: "local",
        channel: "chromium",
        profilesDir: join(dir, "profiles"),
        artifactsDir: join(dir, "artifacts"),
        headless: true,
      },
      { pace: null, repairer, fixes },
    );
    let actMs = 0;
    const pay = defineFlow<undefined, string>({
      site: "scratch",
      name: "pay",
      async run(fp) {
        await fp.open(url);
        const t = Date.now();
        await fp.act(
          { kind: "click" },
          { role: "button", name: "Checkout" },
          { goal: "pay", timeoutMs: 3_000 },
        );
        actMs = Date.now() - t;
        return fp.page.title();
      },
    });
    expect(await runner.run(pay, undefined)).toBe("paid");
    expect(asked).toBe(1);
    expect(actMs).toBeGreaterThanOrEqual(3_000);
    expect(await runner.run(pay, undefined)).toBe("paid");
    expect(asked).toBe(1);
    expect(actMs).toBeLessThan(3_000);
    // A fresh read of the file: the fix outlives the process.
    expect(fileFixes(join(dir, "fixes.json")).list()[0]).toMatchObject({
      flow: "scratch/pay",
      goal: "pay",
      used: 1,
    });
  }, 60_000);

  it("a new screen in the way: one detour click on the live page, then the op; kept for next run", async () => {
    const url = `${await ready}screen`;
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-detour-"));
    const fixes = fileFixes(join(dir, "fixes.json"));
    const asked: number[] = [];
    const repairer: Repairer = {
      id: "detour",
      async propose(req) {
        asked.push(req.detours?.length ?? 0);
        return req.detours?.length
          ? { hints: { role: "button", name: "Pay now" }, reason: "behind a screen" }
          : { hints: { role: "button", name: "Continue" }, reason: "new screen", detour: true };
      },
    };
    const runner = flowRunner(
      {
        tier: "local",
        channel: "chromium",
        profilesDir: join(dir, "profiles"),
        artifactsDir: join(dir, "artifacts"),
        headless: true,
      },
      { pace: null, repairer, fixes },
    );
    const pay = defineFlow<undefined, string>({
      site: "scratch",
      name: "pay-screen",
      async run(fp) {
        await fp.open(url);
        await fp.act(
          { kind: "click" },
          { role: "button", name: "Checkout" },
          { goal: "pay", timeoutMs: 2_000 },
        );
        return fp.page.title();
      },
    });
    expect(await runner.run(pay, undefined)).toBe("paid");
    expect(asked).toEqual([0, 1]);
    expect(fixes.list()[0]).toMatchObject({
      detours: [{ role: "button", name: "Continue" }],
      hints: { role: "button", name: "Pay now" },
    });
    expect(await runner.run(pay, undefined)).toBe("paid");
    expect(asked).toEqual([0, 1]);
  }, 60_000);

  it("never takes a detour that commits something", async () => {
    const url = `${await ready}screen`;
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-detour-"));
    const runner = flowRunner(
      {
        tier: "local",
        channel: "chromium",
        profilesDir: join(dir, "profiles"),
        artifactsDir: join(dir, "artifacts"),
        headless: true,
      },
      {
        pace: null,
        fixes: memoryFixes(),
        repairer: {
          id: "bad",
          propose: async () => ({
            hints: { role: "button", name: "Confirm order" },
            reason: "x",
            detour: true,
          }),
        },
      },
    );
    const pay = defineFlow<undefined, string>({
      site: "scratch",
      name: "pay-bad",
      async run(fp) {
        await fp.open(url);
        await fp.act(
          { kind: "click" },
          { role: "button", name: "Checkout" },
          { goal: "pay", timeoutMs: 1_000 },
        );
        return fp.page.title();
      },
    });
    await expect(runner.run(pay, undefined)).rejects.toThrow();
  }, 60_000);
});
