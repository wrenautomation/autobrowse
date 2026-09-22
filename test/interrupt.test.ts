import { mkdtempSync, readFileSync } from "node:fs";
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
    const failed = await runner.run(bug, undefined).catch((e: FlowFailed) => e);
    expect(failed).toBeInstanceOf(FlowFailed);
    const record = JSON.parse(
      readFileSync((failed as FlowFailed).artifacts.failure as string, "utf8"),
    );
    expect(record).toMatchObject({ site: "scratch", flow: "bug", kind: "failed", goal: null });
    expect(record.error).toBe("no purchasable row");
  }, 60_000);
  it("a flow that ends on Chrome's offline page is FlowInterrupted, not FlowFailed", async () => {
    const offline = defineFlow<undefined, void>({
      site: "scratch",
      name: "offline",
      async run(fp) {
        // An unresolvable host lands on chrome-error://; a flow check failing there is the leg, not the site.
        await fp.page.goto("http://no-such-host.invalid/").catch(() => undefined);
        throw new Error("still on the sign-in page");
      },
    });
    await expect(runner.run(offline, undefined)).rejects.toBeInstanceOf(FlowInterrupted);
  }, 60_000);
});
