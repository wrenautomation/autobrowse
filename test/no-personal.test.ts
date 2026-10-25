/**
 * The shipped workflows and browser flows name no one: no address, phone, home
 * folder, IP, long id or secret in their source, and none of the operator's own
 * values (designs/2026-10-24-operator-defaults.md). The operator's values live in
 * the plan files and the env; a module that needs one reads it from the plan.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnvFile } from "../src/app/config.js";
import { formatHits, type Known, lintFiles } from "../src/compiler/lint.js";

const ROOTS = ["src/workflows", "src/browser/flows"];

/** The npm scope is the product's, not the operator's: every operator installs it. */
const PRODUCT_NAMES = new Set(["src/workflows/roots.ts"]);

/**
 * Ids a platform owns, not a person: Instagram's web app id, Google Admin's
 * settings page id, LEARN's course id. Each is a product constant any operator uses.
 */
const PLATFORM_IDS = new Set([
  "src/browser/flows/instagram-act.ts",
  "src/workflows/workspace-skip-passwords/index.ts",
  "src/browser/flows/learn.ts",
]);

function sources(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if ((p.endsWith(".ts") && !p.endsWith(".test.ts")) || p.endsWith("outline.json"))
        out[p] = readFileSync(p, "utf8");
    }
  };
  for (const r of ROOTS) walk(r);
  return out;
}

/** The operator's own values from the repo's `.env` (names only leave this test); empty on CI. */
function operatorValues(): Known[] {
  loadEnvFile();
  const out: Known[] = [];
  const add = (name: string, kind: string) => {
    const v = process.env[name];
    if (v && v.length >= 3) out.push({ value: v, kind });
  };
  add("OPERATOR_NAME", "operator");
  add("OPERATOR_HANDLE", "operator");
  add("GOOGLE_ADMIN_USER", "email");
  for (const part of (process.env.LINKEDIN_PAGES ?? "").split(","))
    if (part.includes("=")) out.push({ value: part.split("=")[1] as string, kind: "page" });
  return out;
}

describe("no personal data in shipped flows", () => {
  it("every workflow and browser flow names no one", () => {
    const hits = lintFiles(sources(), operatorValues()).filter(
      (h) =>
        !(h.kind === "id" && PLATFORM_IDS.has(h.file)) &&
        !(h.kind === "known:operator" && PRODUCT_NAMES.has(h.file)),
    );
    expect(formatHits(hits)).toBe("");
  });
});
