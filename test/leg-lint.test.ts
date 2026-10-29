/**
 * A leg runs through the engine (`runLeg`, engine/leg.ts) or inside a workflow's step: never a
 * bare `runner.run(` elsewhere. designs/2026-10-29-one-workflow-system.md, the fold.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
/** Steps run under the engine; the runner lives in browser/. */
const INSIDE = ["src/engine/", "src/workflows/", "src/browser/"];
/** Direct runs still allowed, by file: the count may only go down. */
const ALLOWED: Record<string, number> = {
  // a runner that wraps a runner, in workflow deps
  "src/auth/guard.ts": 1,
  // the source of a compiled step, not a call
  "src/compiler/render.ts": 1,
  // explore's held page: the session, not a leg
  "src/explore/server.ts": 1,
  // pass two: they type passwords, one sign-in try per site; each moves alone
  "src/app/cli-auth.ts": 4, // rotate-password, passkey and TOTP enroll, recovery seal
  "src/chores/unsubscribe.ts": 1,
  "src/app/cli-runs.ts": 2, // walks
};
const RUN = /\b\w*(?:[Rr]unner|[Bb]rowser)\s*\.run\(/g;

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );

describe("legs run through the engine", () => {
  it("no direct runner.run outside the engine but the allowed ones", () => {
    const found: Record<string, number> = {};
    for (const f of files(join(ROOT, "src"))) {
      const rel = relative(ROOT, f);
      if (INSIDE.some((d) => rel.startsWith(d))) continue;
      const n = readFileSync(f, "utf8").match(RUN)?.length ?? 0;
      if (n) found[rel] = n;
    }
    expect(found).toEqual(ALLOWED);
  });
});
