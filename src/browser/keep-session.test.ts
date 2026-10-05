import { describe, expect, it } from "vitest";
import { keepSessionCookies, keptDomains } from "./keep-session.js";

const cookie = (name: string, domain: string, expires: number) => ({
  name,
  value: "v",
  domain,
  path: "/",
  expires,
  httpOnly: true,
  secure: true,
  sameSite: "None" as const,
});

describe("keepSessionCookies", () => {
  it("gives the listed domains' session cookies an expiry and leaves the rest", async () => {
    const added: { name: string; expires?: number }[] = [];
    const context = {
      cookies: async () => [
        cookie("li_at", ".www.linkedin.com", -1),
        cookie("SID", ".google.com", -1),
        cookie("bcookie", ".linkedin.com", 1_900_000_000),
        cookie("other", "example.com", -1),
      ],
      addCookies: async (c: typeof added) => void added.push(...c),
    };
    const now = Date.UTC(2026, 9, 5);
    const n = await keepSessionCookies(context as never, keptDomains("linkedin") as RegExp, now);
    expect(n).toBe(1);
    expect(added.map((c) => c.name)).toEqual(["li_at"]);
    expect(added[0]?.expires).toBe(now / 1000 + 30 * 86_400);
  });

  it("is per site, labels included", () => {
    expect(keptDomains("linkedin@wren")).not.toBeNull();
    expect(keptDomains("x")).toBeNull();
  });
});
