import { describe, expect, it } from "vitest";

describe("delegatedScopes", () => {
  it("asks the delegated account for gmail.modify where a consent would ask readonly", async () => {
    const { delegatedScopes, SCOPES } = await import("../src/google-auth.js");
    expect(delegatedScopes([SCOPES.gmailRead, SCOPES.gmailSend])).toEqual([
      SCOPES.gmailModify,
      SCOPES.gmailSend,
    ]);
  });
});
