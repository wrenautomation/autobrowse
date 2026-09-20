import { describe, expect, it } from "vitest";

describe("kebab", () => {
  it("cuts a sentence-long note to a handle at a word boundary", async () => {
    const { kebab } = await import("../src/compiler/structure.js");
    expect(kebab("The goal is to open the Personal info page and report the display name")).toBe(
      "the-goal-is-to-open-the-personal-info",
    );
    expect(kebab("Open settings")).toBe("open-settings");
    expect(kebab("123 !!")).toBe("step");
  });
});

import { structure } from "../src/compiler/structure.js";

describe("structure names", () => {
  it("names a step from a short note, and from the page when the note is a sentence", () => {
    const base = {
      site: "s",
      startedAt: "",
      finishedAt: "",
      trace: null,
      terminal: null,
      commands: [],
    };
    const target = {
      tag: "h1",
      role: "heading",
      name: "Example Domain",
      text: null,
      placeholder: null,
      id: null,
      testId: null,
      href: null,
      inputType: null,
    };
    const rec = {
      ...base,
      name: "r",
      actions: [
        { t: 0, kind: "navigate", url: "https://example.com/" },
        {
          t: 1,
          kind: "note",
          url: "https://example.com/",
          text: "The heading is right there; I will read it and report it.",
        },
        {
          t: 2,
          kind: "read",
          url: "https://example.com/",
          target,
          as: "title",
          value: "Example Domain",
        },
        { t: 3, kind: "navigate", url: "https://example.com/about" },
        { t: 4, kind: "note", url: "https://example.com/about", text: "Checkout" },
        {
          t: 5,
          kind: "click",
          url: "https://example.com/about",
          target: { ...target, role: "button", name: "Go" },
        },
      ],
    } as never;
    const o = structure(rec);
    expect(o.steps.map((s) => [s.name, s.description])).toEqual([
      ["example-com", "The heading is right there; I will read it and report it."],
      ["checkout", "Checkout"],
    ]);
  });
});
