import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { showsAnew } from "../src/film/director.js";
import { loadTape } from "../src/film/tape.js";

const tapeFile = (body: unknown) => {
  const f = join(mkdtempSync(join(tmpdir(), "tape-")), "demo.tape.json");
  writeFileSync(f, JSON.stringify(body));
  return f;
};

describe("tape", () => {
  it("fills the defaults: 1920x1080, dark, a wait of 60 s", async () => {
    const tape = await loadTape(tapeFile({ steps: [{ type: "ls" }, { wait: "❯" }] }));
    expect(tape).toMatchObject({ size: [1920, 1080], theme: "dark", fontSize: 26 });
    expect(tape.steps[1]).toEqual({ wait: "❯", timeoutS: 60 });
  });

  it("refuses a step it does not know, with the file in the error", async () => {
    const f = tapeFile({ steps: [{ click: "#go" }] });
    await expect(loadTape(f)).rejects.toThrow(`${f} is not a tape`);
  });

  it("waits only for text shown after the last key", () => {
    const mark = "❯ echo hi";
    expect(showsAnew(mark, mark, "❯")).toBe(false);
    expect(showsAnew(`${mark}\nhi\n❯`, mark, "❯")).toBe(true);
    // The typed line holds "hi" too; the answer under it is still new.
    expect(showsAnew(`${mark}\nhi`, mark, "hi")).toBe(true);
  });
});
