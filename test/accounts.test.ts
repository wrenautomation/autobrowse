import { memoryCredentials } from "credvault";
import { describe, expect, it } from "vitest";
import {
  accountsOf,
  accountsOn,
  formatAccounts,
  merged,
  pickAccount,
  rowOf,
} from "../src/auth/accounts.js";
import { SITE_LOGINS } from "../src/auth/sites.js";
import type { FlowRunner } from "../src/browser/flow.js";

describe("accounts", () => {
  it("lists every spec'd site by its credential name, then the rest of the store, never values", async () => {
    const store = memoryCredentials({
      google: { username: "w@x.com", password: "pw", totpSecret: "JBSWY3DPEHPK3PXP" },
      "new-tool": {
        username: "w@x.com",
        password: "-",
        via: "google",
        url: "https://t.test/login",
      },
    });
    const rows = await accountsOf({ store, logins: SITE_LOGINS }).list();
    const google = rows.find((r) => r.site === "google");
    expect(google).toMatchObject({
      known: true,
      username: "w@x.com",
      has: { password: true, totpSecret: true, passkeys: false },
    });
    expect(JSON.stringify(rows)).not.toMatch(/pw|JBSWY3DP/);
    // the admin console has its own credential: its own row, empty
    expect(rows.find((r) => r.site === "google-admin")).toMatchObject({
      known: true,
      username: null,
    });
    expect(rows.find((r) => r.site === "cloudflare")).toMatchObject({
      known: true,
      username: null,
    });
    expect(rows.find((r) => r.site === "new-tool")).toMatchObject({
      known: false,
      via: "google",
      url: "https://t.test/login",
    });
  });

  it("save merges onto what is stored; blanks keep, via '' drops; the store's rules hold", async () => {
    const store = memoryCredentials({ instantly: { username: "a", password: "p" } });
    const accounts = accountsOf({ store, logins: SITE_LOGINS });
    await accounts.save("instantly", {
      username: "b",
      password: "",
      totpSecret: "JBSWY3DPEHPK3PXP",
    });
    expect(await store.get("instantly")).toMatchObject({
      username: "b",
      password: "p",
      totpSecret: "JBSWY3DPEHPK3PXP",
    });
    await expect(accounts.save("sentry", { username: "x" })).rejects.toThrow(/password or a via/);
    await expect(accounts.save("bad site!", { username: "x", password: "y" })).rejects.toThrow(
      /not a site name/,
    );
    const row = await accounts.save("sentry", { username: "x", via: "google" });
    expect(row).toMatchObject({ site: "sentry", via: "google", has: { password: false } });
    expect(
      merged(
        { username: "u", password: "p", via: "google", recoveryCodes: [], passkeys: [] },
        { via: "" },
      ),
    ).not.toHaveProperty("via");
    expect(rowOf("x", null, null)).toMatchObject({ known: false, has: { password: false } });
  });

  it("check signs in through the runner on the site's home; a missing credential or site is a clear no", async () => {
    const store = memoryCredentials({ instantly: { username: "a", password: "p" } });
    const ran: string[] = [];
    const runner = {
      run: async (flow: { site: string; name: string }) => {
        ran.push(`${flow.site}/${flow.name}`);
        return "signed in";
      },
    } as unknown as FlowRunner;
    const accounts = accountsOf({ store, logins: SITE_LOGINS, runner });
    expect(await accounts.check("instantly")).toBe("signed in");
    expect(ran).toEqual(["instantly/login"]);
    await expect(accounts.check("cloudflare")).rejects.toThrow(/no credential for cloudflare/);
    await expect(accounts.check("nowhere")).rejects.toThrow(/unknown site/);
    await expect(accountsOf({ store, logins: SITE_LOGINS }).check("instantly")).rejects.toThrow(
      /no browser/,
    );
  });
});

describe("accounts on a platform", () => {
  const store = memoryCredentials({
    instagram: { username: "wrenautomation", password: "a" },
    "instagram@william": { username: "william.jin", password: "b" },
    "x@wren": { username: "x@wrenautomation.com", password: "c" },
    "reddit@a": { username: "first", password: "e" },
    "reddit@b": { username: "second", password: "f" },
    stripe: { username: "billing@wrenautomation.com", password: "d", canary: true },
  });

  it("lists each account by username, then its roles; canaries left out", async () => {
    const rows = await accountsOn(store);
    expect(rows.map((r) => r.name)).toEqual([
      "instagram",
      "instagram@william",
      "reddit@a",
      "reddit@b",
      "x@wren",
    ]);
    expect(rows.map((r) => r.roles)).toEqual([["main"], ["william"], ["a"], ["b"], ["wren"]]);
    expect(formatAccounts(await accountsOn(store, "instagram"))).toBe(
      "instagram\n  wrenautomation  main     password\n  william.jin     william  password",
    );
  });

  it("picks one by role, key, username or a unique part of it; the bare site is main; else lists them", async () => {
    expect(await pickAccount(store, "x")).toBe("x@wren");
    expect(await pickAccount(store, "instagram@william")).toBe("instagram@william");
    expect(await pickAccount(store, "instagram", "william")).toBe("instagram@william");
    expect(await pickAccount(store, "instagram", "wrenautomation")).toBe("instagram");
    expect(await pickAccount(store, "instagram", "jin")).toBe("instagram@william");
    expect(await pickAccount(store, "instagram")).toBe("instagram");
    expect(await pickAccount(store, "reddit", "second")).toBe("reddit@b");
    await expect(pickAccount(store, "reddit")).rejects.toThrow(
      /2 accounts on reddit, none main.*\n.*first/s,
    );
    await expect(pickAccount(store, "instagram", "nobody")).rejects.toThrow(/no account nobody/);
    await expect(pickAccount(store, "stripe")).rejects.toThrow(/no credential stored/);
  });
});
