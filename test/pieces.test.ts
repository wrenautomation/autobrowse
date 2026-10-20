/**
 * A piece (`./mail`, `./google`, `./oauth`) is a pure library: no browser, no Restate, no app
 * code. This walks the static imports of each piece's TypeScript from its entry and fails, with the
 * chain that got there, on a bare import outside the allowlist or a file under a forbidden folder.
 * Type-only imports leave no trace in the build and are skipped.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
/** One line per piece: its entry file. */
const PIECES = ["src/mail/index.ts", "src/google/index.ts", "src/oauth/index.ts"];
/** Bare packages a piece may reach, with their subpaths. `node:*` builtins are always allowed. */
const ALLOWED = new Set(["imapflow", "libmime", "nodemailer"]);
/** Folders no relative import of a piece may reach. */
const FORBIDDEN = ["src/browser/", "src/app/", "src/sites/"];

const FROM = /\b(?:import|export)\s+(?!type\b)[^;'"]*?\bfrom\s*["']([^"']+)["']/g;
const BARE = /^\s*import\s*["']([^"']+)["']/gm;
const DYNAMIC = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

/** The module specifiers a source file imports at run time. */
function importsOf(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out: string[] = [];
  for (const re of [FROM, BARE, DYNAMIC]) {
    for (const m of code.matchAll(re)) out.push(m[1] as string);
  }
  return out;
}

function sourceFor(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const c of [base.replace(/\.js$/, ".ts"), `${base}.ts`, resolve(base, "index.ts")]) {
    if (existsSync(c)) return c;
  }
  return null;
}

const packageOf = (spec: string): string =>
  spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : (spec.split("/")[0] as string);

/** Every problem reachable from `entry`, each with the chain of files that led to it. */
function problemsOf(entry: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const walk = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    const here = [...chain, relative(ROOT, file)];
    for (const spec of importsOf(readFileSync(file, "utf8"))) {
      if (spec.startsWith("node:")) continue;
      if (!spec.startsWith(".")) {
        if (!ALLOWED.has(packageOf(spec))) problems.push(`${here.join(" -> ")} -> ${spec}`);
        continue;
      }
      const next = sourceFor(file, spec);
      if (!next) {
        problems.push(`${here.join(" -> ")} -> ${spec} (no such file)`);
        continue;
      }
      const rel = relative(ROOT, next);
      if (FORBIDDEN.some((f) => rel.startsWith(f))) problems.push(`${here.join(" -> ")} -> ${rel}`);
      else walk(next, here);
    }
  };
  walk(resolve(ROOT, entry), []);
  return problems;
}

describe("pieces stay pure", () => {
  for (const entry of PIECES) {
    it.skipIf(!existsSync(resolve(ROOT, entry)))(
      `${entry} reaches no browser, app or site code`,
      () => {
        expect(problemsOf(entry)).toEqual([]);
      },
    );
  }

  it("reads imports the way the build keeps them", () => {
    const source = [
      '/* import { x } from "commented"; */',
      'import type { A } from "type-only";',
      'import { type B, c } from "kept";',
      'import {\n  d,\n  e,\n} from "multi-line";',
      'export { f } from "./re-export.js";',
      'export type { G } from "type-reexport";',
      'import "side-effect";',
      'const lazy = await import("dynamic");',
    ].join("\n");
    expect(importsOf(source).sort()).toEqual(
      ["./re-export.js", "dynamic", "kept", "multi-line", "side-effect"].sort(),
    );
  });
});
