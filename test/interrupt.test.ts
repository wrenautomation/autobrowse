import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defineFlow,
  FlowFailed,
  FlowInterrupted,
  flowRunner,
  isTransientBrowserError,
} from "../src/browser/flow.js";

describe("isTransientBrowserError", () => {
  it("knows a dead browser or network from a broken flow", () => {
    for (const m of [
      "Target page, context or browser has been closed",
      "page.goto: net::ERR_INTERNET_DISCONNECTED at https://x",
      "browserContext.newPage: Target closed",
      "connect ECONNREFUSED 127.0.0.1:9222",
      "WebSocket is not open",
      "Protocol error (Runtime.evaluate): Target closed.",
    ])
      expect(isTransientBrowserError(new Error(m)), m).toBe(true);
    for (const m of [
      "no purchasable row for x.com",
      "locator.click: Timeout 15000ms exceeded",
      "bad plan",
    ])
      expect(isTransientBrowserError(new Error(m)), m).toBe(false);
  });
});

describe("flowRunner", () => {
  const dir = mkdtempSync(join(tmpdir(), "autobrowse-int-"));
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
  it("a closed browser mid-flow is FlowInterrupted, a flow bug is FlowFailed", async () => {
    const dies = defineFlow<undefined, void>({
      site: "scratch",
      name: "dies",
      async run(fp) {
        await fp.page.context().close();
        await fp.page.goto("data:text/html,<p>after</p>");
      },
    });
    await expect(runner.run(dies, undefined)).rejects.toBeInstanceOf(FlowInterrupted);
    const bug = defineFlow<undefined, void>({
      site: "scratch",
      name: "bug",
      async run() {
        throw new Error("no purchasable row");
      },
    });
    await expect(runner.run(bug, undefined)).rejects.toBeInstanceOf(FlowFailed);
  }, 60_000);
});

describe("pace", () => {
  it("draws log-uniform delays inside the range", async () => {
    const { drawMs, HUMAN_PACE } = await import("../src/browser/flow.js");
    for (const r of [0, 0.25, 0.5, 0.99]) {
      const ms = drawMs(HUMAN_PACE.beforeAct, () => r);
      expect(ms).toBeGreaterThanOrEqual(HUMAN_PACE.beforeAct[0]);
      expect(ms).toBeLessThanOrEqual(HUMAN_PACE.beforeAct[1]);
    }
    expect(drawMs([100, 1000], () => 0.5)).toBe(316);
  });
});
