import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { traceSteps } from "../src/shots/trace-steps.js";

describe("trace steps", () => {
  it("turns a trace's page acts into steps with frames before and after, typed text masked, a failure labelled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trace-steps-"));
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await context.tracing.start({ screenshots: true, snapshots: true });
      const page = await context.newPage();
      await page.setContent(`<label>Note <input></label><button>Go</button>`);
      await page.getByRole("textbox", { name: "Note" }).fill("sk-fake0000000000000000000000");
      await page.getByRole("button", { name: "Go" }).click();
      await page
        .getByRole("button", { name: "Missing" })
        .click({ timeout: 300 })
        .catch(() => undefined);
      await page.waitForTimeout(300);
      const file = join(dir, "t.zip");
      await context.tracing.stop({ path: file });
      const steps = traceSteps(await readFile(file), "traces/m/artifacts/t.zip");
      expect(steps.map((s) => s.action.method)).toEqual(["fill", "click", "click"]);
      const [fill, go, missing] = steps;
      expect(fill?.action.value).toBe("<redacted>");
      expect(go?.obs.frame).toMatch(/^screencast\//);
      expect(go?.next.frame).toMatch(/^screencast\//);
      expect(go?.out.ok).toBe(true);
      expect(missing?.out).toMatchObject({ ok: false, error: expect.stringMatching(/Timeout/) });
      expect(steps.every((s) => s.outcome === "failed" && s.episode.endsWith("t.zip"))).toBe(true);
    } finally {
      await browser.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
