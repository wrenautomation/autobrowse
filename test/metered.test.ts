import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { holdBulk, holdsFrom } from "../src/app/metered.js";

describe("metered", () => {
  it("holds when the mode is on, or auto on a metered network; never when off", () => {
    expect(holdsFrom("on unmetered running\n")).toBe(true);
    expect(holdsFrom("auto metered paused\n")).toBe(true);
    expect(holdsFrom("auto unmetered running\n")).toBe(false);
    expect(holdsFrom("off metered running\n")).toBe(false);
    expect(holdsFrom("")).toBe(false);
  });

  it("asks the script; a missing or failed script never holds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metered-"));
    try {
      const ok = join(dir, "ok.sh");
      await writeFile(ok, 'echo "on unmetered running"\n');
      const bad = join(dir, "bad.sh");
      await writeFile(bad, 'echo "on metered paused"; exit 3\n');
      await chmod(ok, 0o600);
      expect(await holdBulk(ok)).toBe(true);
      expect(await holdBulk(bad)).toBe(false);
      expect(await holdBulk(join(dir, "none.sh"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
