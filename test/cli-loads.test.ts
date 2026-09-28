import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

describe("the CLI", () => {
  // Every command registers at start: a clash (two `steps`) breaks every command, not one.
  it("loads with every command registered", async () => {
    const { stdout } = await promisify(execFile)("pnpm", ["-s", "autobrowse", "--help"], {
      // CI has no .env: the one required setting, so start-up gets to registering.
      env: {
        RESTATE_INGRESS_URL: "http://localhost:8080",
        ...process.env,
        NO_COLOR: "1",
      },
    });
    expect(stdout).toContain("watched");
  }, 60_000);
});
