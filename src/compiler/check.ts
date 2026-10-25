/**
 * The check a finished workflow must pass: the repo's typecheck, read for
 * the workflow's own files, then its test file. What a person runs before
 * committing; here it is what the model's rounds are judged by.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { formatHits, type Known, lintFiles } from "./lint.js";

export interface CheckOptions {
  cwd?: string;
  timeoutMs?: number;
  /** The person's values this workflow must not carry (the account's username). */
  known?: readonly Known[];
}

/** The module and the outline carry no personal data at all; the test, none of the known values. */
const LINTED = ["index.ts", "outline.json", "index.test.ts"];
const LINT_KNOWN_ONLY = ["index.test.ts"];

export async function checkCompiled(dir: string, o: CheckOptions = {}): Promise<string | null> {
  const cwd = o.cwd ?? process.cwd();
  const rel = relative(cwd, dir);
  const files: Record<string, string> = {};
  for (const f of LINTED) {
    const src = await readFile(join(dir, f), "utf8").catch(() => null);
    if (src !== null) files[f] = src;
  }
  const hits = lintFiles(files, o.known ?? [], { knownOnly: LINT_KNOWN_ONLY });
  if (hits.length)
    return `personal data (make it a plan field; a hint may read {field}):\n${formatHits(hits)}`;
  // Incremental: a finish round after the first re-checks only what changed (15s → 7s here).
  const tsc = await run(
    cwd,
    "tsc",
    [
      "--noEmit",
      "--pretty",
      "false",
      "--incremental",
      "--tsBuildInfoFile",
      "node_modules/.cache/autobrowse/tsc.tsbuildinfo",
    ],
    o.timeoutMs,
  );
  const own = tsc.output
    .split("\n")
    .filter((line) => line.includes(rel))
    .join("\n");
  if (own) return `typecheck:\n${own}`;
  if (tsc.code !== 0 && !tsc.output.includes("error TS")) return `typecheck:\n${tsc.output}`;
  const test = await run(cwd, "vitest", ["run", rel], o.timeoutMs);
  if (test.code !== 0) return `tests:\n${trim(test.output)}`;
  return null;
}

function run(
  cwd: string,
  bin: string,
  args: string[],
  timeout = 180_000,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      `${cwd}/node_modules/.bin/${bin}`,
      args,
      { cwd, timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CI: "1" } },
      (err, stdout, stderr) => {
        const code = err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolve({ code, output: `${stdout}${stderr}` });
      },
    );
  });
}

/** Vitest's failure report without its banners and the passing noise. */
function trim(s: string): string {
  const lines = s.split("\n").filter((l) => !/^\s*(✓|RUN|Start at|Duration)/.test(l));
  return lines
    .join("\n")
    .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "")
    .trim()
    .slice(-6_000);
}
