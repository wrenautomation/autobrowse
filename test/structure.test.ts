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
