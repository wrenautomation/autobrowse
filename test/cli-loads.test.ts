import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

describe("the CLI", () => {
  // Every command registers at start: a clash (two `steps`) breaks every command, not one.
  it("loads with every command registered", async () => {
    const { stdout } = await promisify(execFile)("pnpm", ["-s", "autobrowse", "--help"], {
      env: { ...process.env, NO_COLOR: "1" },
    });
    expect(stdout).toContain("watched");
  }, 60_000);
});
