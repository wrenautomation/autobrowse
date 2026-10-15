import { describe, expect, it } from "vitest";
import { RENDER_PARTS, renderArgs, wrenIn } from "./service.js";

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

  it("says why a run failed, from its last lines", async () => {
    await expect(wrenIn("/nowhere")(["video", "watch"], 5000)).rejects.toThrow(/exit|ENOENT/);
  });
});
