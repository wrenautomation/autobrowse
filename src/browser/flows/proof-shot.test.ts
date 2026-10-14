import { describe, expect, it } from "vitest";
import { clipOf, MAX_SHOT_H, snippetOf } from "./proof-shot.js";

describe("proof shot", () => {
  it("matches by the first words, folded", () => {
    expect(snippetOf("  Hello\n\nWorld  ")).toBe("hello world");
    expect(snippetOf("a".repeat(200)).length).toBe(80);
  });

  it("keeps the title and the comment when both fit", () => {
    const clip = clipOf(
      { x: 40, y: 600, w: 500, h: 120 },
      { x: 20, y: 100, w: 700, h: 40 },
      { w: 1280, h: 4000 },
    );
    expect(clip).toEqual({ x: 12, y: 92, w: 716, h: 636 });
  });

  it("keeps the comment alone when the title is far", () => {
    const clip = clipOf(
      { x: 40, y: 3000, w: 500, h: 120 },
      { x: 20, y: 100, w: 700, h: 40 },
      { w: 1280, h: 4000 },
    );
    expect(clip).toEqual({ x: 32, y: 2992, w: 516, h: 136 });
  });

  it("cuts a tall comment and stays inside the page", () => {
    const clip = clipOf({ x: 0, y: 0, w: 1300, h: 5000 }, null, { w: 1280, h: 6000 });
    expect(clip.x).toBe(0);
    expect(clip.w).toBe(1280);
    expect(clip.h).toBe(MAX_SHOT_H + 8);
  });
});
