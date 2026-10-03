import { memoryCredentials } from "credvault";
import { describe, expect, it } from "vitest";
import { FREE_ACCOUNTS, type FreeAccount, freeAccountStep } from "../src/auth/free-accounts.js";

const INBOX = "will@wren-new.test";
const entry = (site: string, via: FreeAccount["via"]): FreeAccount => {
  const a = FREE_ACCOUNTS.find((x) => x.site === site && x.via === via);
  if (!a) throw new Error(`${site} via ${via} left the list`);
  return a;
};
const todoist = entry("todoist", "email");
const notion = entry("notion", "google");

describe("freeAccountStep", () => {
  it("signs up by email until the inbox's account is made, then skips it", async () => {
    const store = memoryCredentials();
    await store.put("todoist", {
      username: "someone@else.test",
      password: "p",
      madeAt: "2026-10-02T00:00:00.000Z",
    });
    expect(await freeAccountStep(store, todoist, INBOX)).toMatchObject({ kind: "signup" });
    await store.put("todoist@wren", { username: INBOX, password: "p" });
    expect(await freeAccountStep(store, todoist, INBOX)).toMatchObject({ kind: "signup" });
    await store.put("todoist@wren", {
      username: INBOX,
      password: "p",
      madeAt: "2026-10-02T00:00:00.000Z",
    });
    expect(await freeAccountStep(store, todoist, INBOX)).toEqual({
      kind: "made",
      key: "todoist@wren",
    });
  });

  it("names a Google sign-in per inbox, and reuses one on file", async () => {
    const store = memoryCredentials();
    expect(await freeAccountStep(store, notion, INBOX)).toMatchObject({
      kind: "google",
      key: "notion@will-wren-new-google",
      stored: false,
    });
    await store.put("notion@n", { username: INBOX, via: "google" });
    expect(await freeAccountStep(store, notion, INBOX)).toMatchObject({
      key: "notion@n",
      stored: true,
    });
  });
});
