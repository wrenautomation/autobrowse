import { describe, expect, it } from "vitest";
import { LoginFailed } from "../src/auth/login.js";
import { NeedsHuman } from "../src/browser/session.js";
import { safeUrls } from "../src/clients/http.js";

const reason =
  "stuck on https://www.loom.com/login?token=abc&next=%2Fhome (after https://x.com/a#code=abc)";

describe("safeUrls", () => {
  it("cuts every URL to origin + path, keeping the words around it", () => {
    expect(safeUrls(reason)).toBe("stuck on https://www.loom.com/login (after https://x.com/a)");
    expect(safeUrls('went to "https://x.com/p?token=abc"')).toBe('went to "https://x.com/p"');
    expect(safeUrls("https://user:abc@x.com/p")).toBe("https://x.com/p");
    expect(safeUrls("https://?token=abc")).toBe("<url>");
    expect(safeUrls("no url here, token=abc")).toBe("no url here, token=abc");
  });

  it("an upper-case scheme loses its query too", () => {
    expect(safeUrls("on HTTPS://x.com/p?token=abc")).not.toContain("abc");
  });

  it("keeps the punctuation after a URL", () => {
    expect(safeUrls("went to https://x.com/p?token=abc.")).toBe("went to https://x.com/p.");
    expect(safeUrls("https://x.com/p?t=1, then")).toBe("https://x.com/p, then");
  });
});

describe("errors that carry a URL", () => {
  it("NeedsHuman never shows the query", () => {
    const e = new NeedsHuman(reason);
    expect(e.message).not.toContain("abc");
    expect(e.message).toContain("https://www.loom.com/login");
    expect(e.name).toBe("NeedsHuman");
  });

  it("LoginFailed never shows the query", () => {
    const e = new LoginFailed("loom", reason);
    expect(e.message).not.toContain("abc");
    expect(e.message).toBe("loom: stuck on https://www.loom.com/login (after https://x.com/a)");
    expect(e.name).toBe("LoginFailed");
  });
});
