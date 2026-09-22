import { describe, expect, it } from "vitest";
import { applyLocator, planLocator, renderLocator } from "../src/browser/locate.js";

describe("planLocator", () => {
  it("prefers test ids, then role+name, then label, placeholder, text, id", () => {
    expect(planLocator({ testId: "buy", role: "button", name: "Buy" })).toEqual({
      by: "testId",
      value: "buy",
    });
    expect(planLocator({ role: "button", name: "Buy now", text: "Buy now" })).toEqual({
      by: "role",
      role: "button",
      name: "Buy now",
    });
    expect(planLocator({ tag: "input", role: "textbox", name: "Domain" })).toEqual({
      by: "role",
      role: "textbox",
      name: "Domain",
    });
    expect(planLocator({ tag: "input", placeholder: "Search" })).toEqual({
      by: "placeholder",
      value: "Search",
    });
    expect(planLocator({ tag: "input", role: "textbox", id: "q" })).toEqual({
      by: "id",
      value: "q",
    });
    expect(planLocator({ tag: "span", text: "Hello" })).toEqual({ by: "text", value: "Hello" });
    expect(planLocator({ tag: "div" })).toBeNull();
  });

  it("renders the same plan as source", () => {
    expect(renderLocator({ by: "role", role: "button", name: 'Say "hi"' })).toBe(
      'page.getByRole("button", { name: "Say \\"hi\\"", exact: true })',
    );
    expect(renderLocator({ by: "id", value: "go" })).toBe('page.locator("#go")');
    expect(renderLocator({ by: "role", role: "link", name: "/use another/i" })).toBe(
      'page.getByRole("link", { name: /use another/i })',
    );
    expect(renderLocator({ by: "text", value: "/admin/i" })).toBe("page.getByText(/admin/i)");
  });
});

describe("a hint inside an iframe", () => {
  it("reaches through a FrameLocator, which the page's own locators cannot", () => {
    const calls: string[] = [];
    const inner = {
      locator: (v: string) => {
        calls.push(`frame.locator ${v}`);
        return "inner" as unknown as never;
      },
      getByRole: () => "inner" as unknown as never,
    };
    const page = {
      frameLocator: (sel: string) => {
        calls.push(`frameLocator ${sel}`);
        return inner;
      },
      locator: (v: string) => {
        calls.push(`page.locator ${v}`);
        return "outer" as unknown as never;
      },
    } as unknown as Parameters<typeof applyLocator>[0];
    applyLocator(page, { by: "css", value: "div[role=button]" }, 'iframe[src*="gsi/button"]');
    expect(calls).toEqual([
      'frameLocator iframe[src*="gsi/button"]',
      "frame.locator div[role=button]",
    ]);
    calls.length = 0;
    applyLocator(page, { by: "css", value: "a" });
    expect(calls).toEqual(["page.locator a"]);
  });
});
