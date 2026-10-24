import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { writeRendered } from "../src/compiler/index.js";
import type { Outline } from "../src/compiler/outline.js";
import { render } from "../src/compiler/render.js";
import { linkLibraries, PACKAGE, userWorkflowsDir } from "../src/workflows/roots.js";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

describe("user workflow folder", () => {
  it("defaults to ~/.config and takes AUTOBROWSE_WORKFLOWS", () => {
    expect(userWorkflowsDir({}, "/h")).toBe("/h/.config/autobrowse/workflows");
    expect(userWorkflowsDir({ AUTOBROWSE_WORKFLOWS: "/w" }, "/h")).toBe("/w");
  });

  it("loads a flow compiled outside the tree by the package name", async () => {
    const root = mkdtempSync(join(tmpdir(), "wf-user-"));
    const pkg = { root: repo, zod: realpathSync(join(repo, "node_modules/zod")) };
    await linkLibraries(root, pkg);
    const outline: Outline = {
      name: "hello-page",
      site: "example",
      description: "Open a page",
      fields: [],
      secrets: [],
      steps: [
        {
          kind: "browser",
          name: "open",
          description: "Open the page",
          irreversible: false,
          proof: null,
          url: "https://example.com",
          ops: [],
        },
      ],
    };
    const out = render(outline, { lib: PACKAGE });
    await writeRendered(join(root, outline.name), out);
    // Linking twice keeps the links.
    await linkLibraries(root, pkg);
    // Node itself loads it, as an install does: type stripping, bare names through the links.
    const url = pathToFileURL(join(root, outline.name, "index.ts")).href;
    const name = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `console.log((await import(${JSON.stringify(url)})).workflow.name)`,
      ],
      { encoding: "utf8" },
    );
    expect(name.trim()).toBe("hello-page");
  });
});
