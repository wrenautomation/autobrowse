import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { clipOf, findOn, MAX_SHOT_H, snippetOf } from "./proof-shot.js";

/** A synthetic thread in www.reddit's shape: the post's title, then two comments. */
const THREAD = `<shreddit-post><h1 slot="title">A synthetic title</h1></shreddit-post>
<shreddit-comment thingid="t1_aaa"><div slot="commentMeta">someone</div><div slot="comment"><p>First words here</p></div></shreddit-comment>
<shreddit-comment thingid="t1_bbb"><div slot="commentMeta">us</div><div slot="comment"><p>Ask which step they drop at, then fix that one.</p></div></shreddit-comment>`;

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

  it("finds the comment in a page by its id, or by its first words", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(THREAD);
      const byRef = await findOn(page, "t1_bbb", null);
      expect(byRef.comment?.h).toBeGreaterThan(0);
      expect(byRef.text).toContain("Ask which step");
      expect(byRef.titleText).toBe("A synthetic title");
      const byText = await findOn(page, null, snippetOf("Ask which step they drop at"));
      expect(byText.text).toContain("Ask which step");
      expect((await findOn(page, "t1_none", null)).comment).toBeNull();
    } finally {
      await browser.close();
    }
  });
});
