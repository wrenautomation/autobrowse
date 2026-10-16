import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RENDER_PARTS, renderArgs, wrenCheckout, wrenIn } from "./service.js";

describe("studio", () => {
  it("renders with the cut pass first", () => {
    expect(renderArgs(12)).toEqual(["video", "render", "12", "--cut"]);
  });

  it("narrows a render to one part", () => {
    expect(renderArgs(12, "shorts")).toEqual([
      "video",
      "render",
      "12",
      "--cut",
      "--only",
      "shorts",
    ]);
    expect(RENDER_PARTS).toContain("long");
    expect(renderArgs(12, undefined, true)).toEqual(["video", "render", "12", "--cut", "--again"]);
  });

  it("runs the desk's own wren checkout when there is one, else the main one", () => {
    const ws = mkdtempSync(join(tmpdir(), "ws-"));
    expect(wrenCheckout(ws, {})).toBe(join(ws, "wren"));
    mkdirSync(join(ws, "wren-desk/scripts"), { recursive: true });
    writeFileSync(join(ws, "wren-desk/scripts/prod-wren.mjs"), "");
    expect(wrenCheckout(ws, {})).toBe(join(ws, "wren-desk"));
    expect(wrenCheckout(ws, { AUTOBROWSE_WREN_CHECKOUT: "/elsewhere" })).toBe("/elsewhere");
  });

  it("says why a run failed, from its last lines", async () => {
    await expect(wrenIn("/nowhere")(["video", "watch"], 5000)).rejects.toThrow(/exit|ENOENT/);
  });
});
