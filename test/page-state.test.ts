import { describe, expect, it } from "vitest";
import { describePage, isLoading } from "../src/browser/page-state.js";

describe("describePage", () => {
  it("says a spinner is a spinner", () => {
    expect(isLoading("")).toBe(true);
    expect(isLoading("  Loading... ")).toBe(true);
    expect(isLoading("Log in to Notion")).toBe(false);
    expect(describePage("https://app.notion.com/?x=1", "Loading...")).toBe(
      "https://app.notion.com/ is still loading (a blank page or spinner)",
    );
  });
  it("quotes the error a page prints, else its first words", () => {
    expect(describePage("https://a.test/s", "Sign in. Something went wrong, please retry.")).toBe(
      'https://a.test/s says "Sign in. Something went wrong, please retry."',
    );
    expect(describePage("https://a.test/s", "Welcome back")).toBe(
      'https://a.test/s shows "Welcome back"',
    );
    expect(describePage("https://a.test/s", "Verify you are human")).toBe(
      "a bot check at https://a.test/s",
    );
  });
});
