import { describe, expect, it } from "vitest";
import { INVITE_LIMIT } from "../src/browser/flows/linkedin-reach.js";
import { linkedin } from "../src/sites/linkedin.js";
import { SiteError } from "../src/sites/types.js";

const connect = linkedin.routes.find((r) => r.path === "/in/{vanity}/connect");

describe("LinkedIn's weekly invitation limit", () => {
  it("reads the notice", () => {
    expect(INVITE_LIMIT.test("You've reached the weekly invitation limit")).toBe(true);
    expect(INVITE_LIMIT.test("Invitation sent")).toBe(false);
  });

  it("the route answers it as a 429 with a day's wait", () => {
    const output = connect?.browser?.output;
    if (!output) throw new Error("no connect output");
    let err: unknown;
    try {
      output({ sent: false, limit: "You've reached the weekly invitation limit" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SiteError);
    expect((err as SiteError).status).toBe(429);
    expect((err as SiteError).retryAfter).toBe(86_400);
    expect((err as SiteError).message).toMatch(/weekly invitation limit.*retry after 86400s/);
    expect(output({ sent: true, note: false })).toEqual({ sent: true, note: false });
  });
});
