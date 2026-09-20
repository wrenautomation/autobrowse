import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { backendFor, localParts, proofsOf, workflowsOf } from "../src/app/backend.js";
import { loadSettings } from "../src/app/config.js";
import { WORKFLOWS } from "../src/app/services.js";
import { defineFlow } from "../src/browser/flow.js";
import { defineWorkflow, done } from "../src/engine/workflow.js";
import { fakeLlm } from "../src/llm/fake.js";
import { eventBus } from "../src/ui/bus.js";
import { readProof } from "../src/workflows/proof.js";
import { fakeBrowser } from "./fakes.js";

const settings = loadSettings({ RESTATE_INGRESS_URL: "http://127.0.0.1:8080", BROWSER: "local" });
const readTitle = defineFlow<Record<string, never>, Record<string, string>>({
  site: "example",
  name: "read-title",
  async run() {
    return { title: "x" };
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
        return done(JSON.stringify(await fx.run("browser", () => deps.browser.run(readTitle, {}))));
      },
    },
  ],
  emptyMemo: () => ({}),
});

function parts() {
  const dir = mkdtempSync(join(tmpdir(), "backend-"));
  const browser = fakeBrowser([]);
  browser.on(readTitle, async () => ({ title: "Example" }));
  const compiled = { workflow: workflow as never, dir, proof: null };
  return {
    dir,
    parts: {
      catalog: {
        list: async () => [compiled],
        get: async (name: string) => (name === workflow.name ? compiled : null),
        proofs: async () => ({ [workflow.name]: null }),
      },
      browser,
      sink: { put: async () => undefined },
      bus: eventBus(),
      workflows: async () => [workflow as never],
      proofs: async () => ({ [workflow.name]: null }),
    },
  };
}
const ingress = {} as never;

describe("backendFor", () => {
  it("without a model: workflows, proofs and prove; no agent, heal or budget", async () => {
    const { dir, parts: p } = parts();
    const b = backendFor(settings, p, { llm: null, ingress });
    expect((await workflowsOf(b)).map((w) => w.name)).toEqual(["example-title"]);
    expect(await proofsOf(b)).toEqual({ "example-title": null });
    expect(b.agent).toBeUndefined();
    expect(b.heal).toBeUndefined();
    expect(b.llm).toBeUndefined();
    expect(b.budget).toBeUndefined();
    const proof = await b.prove?.("example-title");
    expect(proof?.status).toBe("done");
    expect(await readProof(dir)).toEqual(proof);
    await expect(b.prove?.("nope")).rejects.toThrow(/did not load/);
  });

  it("with a model: agent, heal, llm and budget come along", () => {
    const { parts: p } = parts();
    const b = backendFor(settings, p, { llm: fakeLlm([]), ingress });
    expect(b.agent).toBeDefined();
    expect(b.heal).toBeDefined();
    expect(b.llm).toBeDefined();
    expect(b.outline).toBeDefined();
    expect(b.recordingsDir).not.toMatch(/^~/);
  });

  it("local parts list the hand-written workflows plus what the catalog holds", async () => {
    const p = localParts(settings, { headless: true });
    const names = (await p.workflows()).map((w) => w.name);
    for (const w of WORKFLOWS) expect(names).toContain(w.name);
  });
});
