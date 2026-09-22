import { memoryCredentials } from "credkeep";
import { describe, expect, it } from "vitest";
import { accountsOf, merged, rowOf } from "../src/auth/accounts.js";
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
