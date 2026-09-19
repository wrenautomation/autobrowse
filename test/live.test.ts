/**
 * Real services, real keys: skipped unless the env has them. Cheap calls
 * only (one memory write + read, one tiny completion). Run with
 * `pnpm test:live`.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadEnvFile, loadSettings } from "../src/app/config.js";
import { llmFor, memoryFor } from "../src/app/services.js";
import { completeJson } from "../src/llm/types.js";

loadEnvFile();
const settings = loadSettings();
const live = process.env.LIVE === "1";

describe.skipIf(!live)("live", () => {
  it("backboard remembers and recalls", async () => {
    const memory = memoryFor(settings);
    expect(memory.id).toMatch(/^backboard/);
    const stamp = `live-${Date.now()}`;
    await memory.remember(
      `site=example goal=click Continue repaired (${stamp}) hints={"role":"button","name":"Continue"}`,
      { kind: "test" },
    );
    // Search is eventually consistent on their side; give it a few tries.
    let hits: Awaited<ReturnType<typeof memory.recall>> = [];
    for (let i = 0; i < 10 && !hits.some((h) => h.content.includes(stamp)); i++) {
      await new Promise((r) => setTimeout(r, 1500));
      hits = await memory.recall("example click Continue", 10);
    }
    expect(hits.some((h) => h.content.includes(stamp))).toBe(true);
  }, 60_000);

  it("the configured model returns valid JSON through completeJson", async () => {
    const llm = llmFor(settings);
    if (!llm) throw new Error("no model configured");
    const { value } = await completeJson(llm, z.object({ ok: z.boolean() }), {
      system: "Reply with JSON only.",
      prompt: 'Return {"ok": true}',
      maxTokens: 50,
    });
    expect(value.ok).toBe(true);
  }, 30_000);
});
