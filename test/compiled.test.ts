import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKFLOWS } from "../src/app/services.js";
import {
  compiledCatalog,
  compiledDeps,
  compiledKey,
  HAND_WRITTEN,
  loadCompiledWorkflows,
  splitCompiledKey,
} from "../src/workflows/compiled.js";

describe("loadCompiledWorkflows", () => {
  it("loads every dir exporting a workflow, skips hand-written names and broken modules", async () => {
    const root = mkdtempSync(join(tmpdir(), "wf-"));
    mkdirSync(join(root, "good"));
    writeFileSync(
      join(root, "good", "index.ts"),
      `export const workflow = { name: "good", description: "d", steps: [{ name: "a" }] };`,
    );
    writeFileSync(
      join(root, "good", "proof.json"),
      JSON.stringify({ at: "2026-09-20T05:00:00Z", status: "done", steps: [], output: null }),
    );
    mkdirSync(join(root, "domain"));
    writeFileSync(
      join(root, "domain", "index.ts"),
      `export const workflow = { name: "domain", steps: [] };`,
    );
    mkdirSync(join(root, "broken"));
    writeFileSync(join(root, "broken", "index.ts"), `throw new Error("boom");`);
    mkdirSync(join(root, "empty"));
    const errors: string[] = [];
    const found = await loadCompiledWorkflows(root, (dir) =>
      errors.push(dir.split("/").pop() ?? ""),
    );
    expect(found.map((f) => f.workflow.name)).toEqual(["good"]);
    expect(found[0]?.proof?.status).toBe("done");
    expect(errors).toEqual(["broken"]);
    expect(await loadCompiledWorkflows(join(root, "nope"))).toEqual([]);
  });
});

describe("compiledCatalog", () => {
  it("sees a new flow and a rewritten one without a restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "wf-"));
    const catalog = compiledCatalog(root);
    expect(await catalog.list()).toEqual([]);
    mkdirSync(join(root, "one"));
    const file = join(root, "one", "index.ts");
    writeFileSync(file, `export const workflow = { name: "one", description: "v1", steps: [] };`);
    expect((await catalog.get("one"))?.workflow.description).toBe("v1");
    // A rewrite lands with a later mtime; the loader keys the import on it.
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(file, `export const workflow = { name: "one", description: "v2", steps: [] };`);
    expect((await catalog.get("one"))?.workflow.description).toBe("v2");
    expect(await catalog.get("two")).toBeNull();
    expect(await catalog.proofs()).toEqual({ one: null });
  });
});

describe("compiled keys", () => {
  it("joins and splits, keeping slashes inside the run key", () => {
    expect(splitCompiledKey(compiledKey("google-name", "a/b"))).toEqual({
      workflow: "google-name",
      key: "a/b",
    });
    expect(() => splitCompiledKey("nokey")).toThrow(/<workflow>\/<key>/);
    expect(() => splitCompiledKey("w/")).toThrow();
    expect(() => splitCompiledKey("/k")).toThrow();
  });
});

describe("compiledDeps", () => {
  it("serves a redacted value from AUTOBROWSE_<KEY> and names the variable when it is missing", async () => {
    const browser = { run: async () => undefined } as never;
    process.env.AUTOBROWSE_CARD_CVV = "123";
    try {
      const deps = compiledDeps(browser);
      expect(await deps.secrets.get("cardCvv")).toBe("123");
      await expect(deps.secrets.get("apiKey")).rejects.toThrow(/set AUTOBROWSE_API_KEY/);
      expect((await deps.shell.run("echo hi")).code).toBe(0);
    } finally {
      delete process.env.AUTOBROWSE_CARD_CVV;
    }
  });
});

describe("HAND_WRITTEN", () => {
  it("names exactly the workflows the worker serves under their own objects", () => {
    // The ingress routes by this set; a hand-written flow missing from it would be sent to Compiled.
    expect(new Set(WORKFLOWS.map((w) => w.name))).toEqual(HAND_WRITTEN);
  });
});
