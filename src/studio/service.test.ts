import { describe, expect, it } from "vitest";
import { renderArgs, wrenIn } from "./service.js";

describe("studio", () => {
  it("renders with the cut pass first", () => {
    expect(renderArgs(12)).toEqual(["video", "render", "12", "--cut"]);
  });

  it("says why a run failed, from its last lines", async () => {
    await expect(wrenIn("/nowhere")(["video", "watch"], 5000)).rejects.toThrow(/exit|ENOENT/);
  });
});
