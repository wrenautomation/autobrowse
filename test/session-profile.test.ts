import { describe, expect, it } from "vitest";
import { profileOf } from "../src/sites/wire.js";
import type { Credential, CredentialStore } from "../src/auth/credentials.js";

const cred = (username: string, extra: Partial<Credential> = {}): Credential =>
  ({ username, password: "x", recoveryCodes: [], passkeys: [], ...extra }) as Credential;

function store(rows: Record<string, Credential>): CredentialStore {
  return {
    get: async (name) => rows[name] ?? null,
    put: async () => {},
    list: async () => Object.keys(rows),
  };
}

describe("the profile a via-credential works in", () => {
  it("is the provider's own credential when the usernames match", async () => {
    const s = store({
      google: cred("me@gmail.com"),
      linkedin: cred("me@gmail.com", { via: "google", password: undefined }),
    });
    expect(await profileOf(s, "google", "me@gmail.com")).toBe("google");
  });

  it("is the second account's credential when it is another one at the provider", async () => {
    const s = store({
      google: cred("me@gmail.com"),
      "google@wren": cred("wren@example.com"),
    });
    expect(await profileOf(s, "google", "wren@example.com")).toBe("google@wren");
  });

  it("is nothing when the provider has no credential for that address", async () => {
    expect(await profileOf(store({ google: cred("me@gmail.com") }), "google", "no@one")).toBe(null);
  });
});
