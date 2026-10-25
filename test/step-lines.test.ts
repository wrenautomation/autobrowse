import { describe, expect, it } from "vitest";
import { stepLines } from "../src/app/step-lines.js";
import { shortHome } from "../src/google/auth.js";

describe("stepLines", () => {
  it("keeps a plain detail on the step's line, names padded to the longest", () => {
    expect(
      stepLines([
        { name: "open", status: "done", detail: "Open the page" },
        { name: "search-query", status: "failed", detail: "Error: no rows" },
      ]),
    ).toEqual(["open          done  Open the page", "search-query  failed  Error: no rows"]);
  });

  it("puts each value of a step's out on its own line, a list one row per line", () => {
    const detail = JSON.stringify({
      stories: [
        { title: "A", points: "467" },
        { title: "B", points: "408" },
      ],
      total: 2,
    });
    expect(stepLines([{ name: "read", status: "done", detail }])).toEqual([
      "read  done",
      "  stories",
      "    A  467",
      "    B  408",
      "  total  2",
    ]);
  });

  it("keeps a detail that is not an object of values as it is", () => {
    expect(stepLines([{ name: "s", status: "done", detail: "{not json" }])).toEqual([
      "s  done  {not json",
    ]);
    expect(stepLines([{ name: "s", status: "done", detail: "" }])).toEqual(["s  done"]);
  });
});

describe("shortHome", () => {
  it("shows a path under home as ~, and leaves the rest", () => {
    expect(shortHome("/home/a/.config/x", "/home/a")).toBe("~/.config/x");
    expect(shortHome("/home/a", "/home/a")).toBe("~");
    expect(shortHome("/home/ab/x", "/home/a")).toBe("/home/ab/x");
  });
});
