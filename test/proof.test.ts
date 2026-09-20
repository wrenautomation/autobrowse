import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineFlow } from "../src/browser/flow.js";
import { defineWorkflow, done } from "../src/engine/workflow.js";
import { proofLine, proveWorkflow, readProof, writeProof } from "../src/workflows/proof.js";
import { fakeBrowser } from "./fakes.js";

const readTitle = defineFlow<Record<string, never>, Record<string, string>>({
  site: "example",
  name: "read-title",
  async run() {
    return { title: "Example Domain" };
  },
});

const workflow = defineWorkflow<{ browser: ReturnType<typeof fakeBrowser> }, object>()({
  name: "example-title",
  description: "read the title",
  plan: z.object({ dryRun: z.boolean().default(false) }),
  steps: [
    {
      name: "read-title",
      async run({ fx, deps }) {
        const out = await fx.run("browser", () => deps.browser.run(readTitle, {}));
        return done(JSON.stringify(out));
      },
    },
  ],
  emptyMemo: () => ({}),
});

describe("proveWorkflow", () => {
  it("runs the flow once, keeps the read output, and round-trips through proof.json", async () => {
    const browser = fakeBrowser([]);
    browser.on(readTitle, async () => ({ title: "Example Domain" }));
    const proof = await proveWorkflow(workflow as never, browser, {
      now: () => new Date("2026-09-20T05:00:00Z"),
    });
    expect(proof).toEqual({
      at: "2026-09-20T05:00:00.000Z",
      status: "done",
      steps: [{ name: "read-title", status: "done", detail: '{"title":"Example Domain"}' }],
      output: { title: "Example Domain" },
    });
    const dir = mkdtempSync(join(tmpdir(), "proof-"));
    writeProof(dir, proof);
    expect(readProof(dir)).toEqual(proof);
    expect(readProof(join(dir, "nope"))).toBeNull();
    expect(proofLine(proof)).toBe('proven 2026-09-20T05:00 → {"title":"Example Domain"}');
  });
  it("records the failing step when the flow breaks", async () => {
    const browser = fakeBrowser([]);
    browser.on(readTitle, async () => {
      throw new Error("no heading on the page");
    });
    const proof = await proveWorkflow(workflow as never, browser);
    expect(proof.status).toBe("failed");
    expect(proof.output).toBeNull();
    expect(proofLine(proof)).toMatch(/^proof failed at read-title: .*no heading/);
  });
});
