import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineFlow, flowRunner } from "../src/browser/flow.js";
import type { Repairer, RepairReport } from "../src/browser/repair.js";
import { NeedsHuman } from "../src/browser/session.js";

const PAGE = `data:text/html,${encodeURIComponent(
  `<label>Domain <input id="d"></label><button id="go" onclick="document.title='clicked'">Buy now</button>`,
)}`;

describe("fp.act", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "repair-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const runner = (repairer: Repairer, reports: RepairReport[]) =>
    flowRunner(
      {
        tier: "local",
        channel: "chromium",
        profilesDir: join(dir, "profiles"),
        artifactsDir: join(dir, "artifacts"),
        headless: true,
      },
      { repairer, onRepair: (r) => reports.push(r), pace: null },
    );

  it("repairs a stale locator through the repairer and reports it", async () => {
    const reports: RepairReport[] = [];
    const repairer: Repairer = {
      id: "test",
      async propose(req) {
        expect(req.snapshot).toContain("text=Buy now");
        return { hints: { role: "button", name: "Buy now" }, reason: "label changed" };
      },
    };
    const flow = defineFlow<Record<string, never>, string>({
      site: "scratch",
      name: "repair",
      async run(fp) {
        await fp.page.goto(PAGE);
        await fp.act(
          { kind: "fill", value: "x.com" },
          { role: "textbox", name: "Domain" },
          { goal: "fill Domain", timeoutMs: 500 },
        );
        await fp.act(
          { kind: "click" },
          { role: "button", name: "Purchase" },
          { goal: "click Purchase", timeoutMs: 500 },
        );
        return fp.page.title();
      },
    });
    expect(await runner(repairer, reports).run(flow, {})).toBe("clicked");
    expect(reports).toMatchObject([{ goal: "click Purchase", ok: true, flow: "scratch/repair" }]);
  }, 30_000);

  it("never repairs an irreversible op: a miss asks a person", async () => {
    const reports: RepairReport[] = [];
    const repairer: Repairer = {
      id: "test",
      propose: async () => ({ hints: { id: "go" }, reason: "no" }),
    };
    const flow = defineFlow<Record<string, never>, void>({
      site: "scratch",
      name: "irreversible",
      async run(fp) {
        await fp.page.goto(PAGE);
        await fp.act(
          { kind: "click" },
          { role: "button", name: "Pay" },
          { goal: "click Pay", irreversible: true, timeoutMs: 500 },
        );
      },
    });
    await expect(runner(repairer, reports).run(flow, {})).rejects.toBeInstanceOf(NeedsHuman);
    expect(reports).toEqual([]);
  }, 30_000);
});
