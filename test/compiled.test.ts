import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCompiledWorkflows } from "../src/workflows/compiled.js";

describe("loadCompiledWorkflows", () => {
  it("loads every dir exporting a workflow, skips hand-written names and broken modules", async () => {
    const root = mkdtempSync(join(tmpdir(), "wf-"));
    mkdirSync(join(root, "good"));
    writeFileSync(
      join(root, "good", "index.ts"),
      `export const workflow = { name: "good", description: "d", steps: [{ name: "a" }] };`,
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
    expect(errors).toEqual(["broken"]);
    expect(await loadCompiledWorkflows(join(root, "nope"))).toEqual([]);
  });
});
