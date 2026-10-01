import { describe, expect, it } from "vitest";
import { type Box, layout } from "../src/browser/layout.js";

/** A line of text at (x, y), 16px tall, 8px a character. */
const box = (t: string, x: number, y: number, extra: Partial<Box> = {}): Box => ({
  t,
  x,
  y,
  w: t.length * 8,
  h: 16,
  ...extra,
});

describe("layout", () => {
  it("a label beside its value is one row", () => {
    expect(layout([box("Price", 0, 0), box("$40", 300, 0), box("Total", 0, 40)])).toBe(
      "Price | $40\nTotal",
    );
  });

  it("columns that line up row by row read across, a line under one runs alone", () => {
    const hn = [
      box("1.", 0, 0),
      box("Story one", 40, 0),
      box("10 points", 40, 20),
      box("2.", 0, 50),
      box("Story two", 40, 50),
      box("5 points", 40, 70),
    ];
    expect(layout(hn)).toBe("1. | Story one\n10 points\n2. | Story two\n5 points");
  });

  it("a sidebar beside an article is two columns, never read across", () => {
    const page = [
      box("Contents", 0, 0),
      box("History", 0, 20),
      box("Methods", 0, 40),
      box("Legal", 0, 60),
      box("Web scraping", 300, 0, { lvl: 1 }),
      { t: "A long paragraph about scraping.", x: 300, y: 30, w: 600, h: 80 },
    ];
    expect(layout(page)).toBe(
      "[col 1/2]\n Contents\n History\n Methods\n Legal\n[col 2/2]\n # Web scraping\n A long paragraph about scraping.",
    );
  });

  it("a link alone at the header's right end stays in the header row", () => {
    const page = [
      box("Home", 0, 0),
      box("login", 1000, 0),
      box("First line", 0, 30),
      box("Second line", 0, 50),
      box("Third line", 0, 70),
    ];
    expect(layout(page).split("\n")[0]).toBe("Home | login");
    expect(layout(page)).not.toContain("[col");
  });

  it("boxes with no gap between them on one line join with a space", () => {
    expect(layout([box("owner", 0, 0), box("/", 42, 0), box("repo", 52, 0)])).toBe("owner / repo");
  });

  it("wrapped chips read row by row", () => {
    const chips = [
      box("aa", 0, 0),
      box("bb", 28, 0),
      box("cc", 56, 0),
      box("dd", 0, 24),
      box("ee", 28, 24),
    ];
    expect(layout(chips)).toBe("aa | bb | cc\ndd | ee");
  });

  it("coords put each line's page position first, once per row", () => {
    expect(layout([box("Price", 10, 5), box("$40", 300, 5)], { coords: true })).toBe(
      "@10,5 Price | $40",
    );
  });

  it("no boxes, no text", () => {
    expect(layout([])).toBe("");
  });
});
