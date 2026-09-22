import { describe, expect, it } from "vitest";
import type { Credential, CredentialStore } from "../src/auth/credentials.js";
import { codesOn, sealRecoveryCodesFlow } from "../src/auth/recovery.js";
import { SITE_LOGINS } from "../src/auth/sites.js";
import { loadedCount } from "../src/browser/webauthn.js";
import { fakePage } from "./auth-fakes.js";

const CODE = (n: number) => n.toString(16).padStart(64, "0");

const memoryStore = (cred: Credential) => {
  const held = new Map([["npm", cred]]);
  return {
    held,
    store: {
      get: async (n: string) => held.get(n) ?? null,
      put: async (n: string, c: Credential) => void held.set(n, c),
    } as unknown as CredentialStore,
  };
};

describe("recovery codes", () => {
  it("reads each code once, whatever the flags", () => {
    const text = `${CODE(1)} ${CODE(2)} ${CODE(1)} short abc`;
    expect(codesOn(text, /\b[0-9a-f]{64}\b/i)).toEqual([CODE(1), CODE(2)]);
    expect(codesOn("none here", /\b[0-9a-f]{64}\b/g)).toEqual([]);
  });

  it("unlocks npm's page with the key, seals the codes, prints only the count", async () => {
    const npm = SITE_LOGINS.find((l) => l.site === "npm");
    if (!npm) throw new Error("no npm login");
    const { held, store } = memoryStore({
      username: "william_jin",
      password: "p",
      recoveryCodes: [],
      passkeys: [],
    });
    const { fp, acts } = fakePage({
      text: ["Use security key", `Recovery Codes ${CODE(7)} ${CODE(8)}`],
      present: () => true,
    });
    const flow = sealRecoveryCodesFlow(npm, store);
    const said = await flow.run(fp, undefined);
    expect(said).toBe("2 recovery codes sealed for npm");
    expect(said).not.toContain(CODE(7));
    expect(held.get("npm")?.recoveryCodes).toEqual([CODE(7), CODE(8)]);
    expect(acts[0]?.hints).toEqual({ role: "button", name: "Use security key" });
  });
});

describe("passkey sign count", () => {
  it("counts from the clock so a reloaded key never repeats a count the site saw", () => {
    const now = Date.UTC(2026, 8, 22);
    expect(loadedCount(1, now)).toBe(now / 1000);
    expect(loadedCount(now, now)).toBe(now);
    expect(loadedCount(1, now + 1000)).toBeGreaterThan(loadedCount(1, now));
  });
});
