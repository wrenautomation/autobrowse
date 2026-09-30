import { describe, expect, it } from "vitest";
import { API_SIGNUPS } from "../src/auth/signup.js";
import { npmCreateOrg } from "../src/browser/flows/npm-create-org.js";
import { tokenName } from "../src/browser/flows/npm-granular-token.js";
import { npmTrustedPublisher } from "../src/browser/flows/npm-trusted-publisher.js";
import type { HttpClient, JsonRequest } from "../src/clients/http.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { createRegistryUser, NPM_TOKEN, npm } from "../src/sites/npm.js";

/** A door that answers one canned response and keeps what it was asked. */
const door = (res: { status: number; body: unknown }) => {
  const calls: Array<{ url: string; req?: JsonRequest }> = [];
  const http: HttpClient = {
    json: async (url, req) => {
      calls.push({ url, ...(req ? { req } : {}) });
      return {
        status: res.status,
        ok: res.status < 400,
        body: res.body as never,
        headers: new Headers(),
      };
    },
  };
  return { http, calls };
};

describe("npm", () => {
  it("makes the account through the registry and reads back the token", async () => {
    const { http, calls } = door({ status: 201, body: { ok: "user created", token: "npm_x" } });
    const made = await createRegistryUser(http, {
      name: "wrenautomation",
      email: "a@b.com",
      password: "sealed",
    });
    expect(made).toEqual({ token: "npm_x", note: "user created" });
    expect(calls[0]?.url).toBe("https://registry.npmjs.org/-/user/org.couchdb.user:wrenautomation");
    expect(calls[0]?.req?.method).toBe("PUT");
  });

  it("a refusal is a refusal: npm's own words, never read as success", async () => {
    const { http } = door({
      status: 403,
      body: { ok: false, error: "Account creation via legacy auth is unavailable." },
    });
    await expect(
      createRegistryUser(http, { name: "taken", email: "a@b.com", password: "sealed" }),
    ).rejects.toThrow(/403/);
  });

  it("the signup takes the sealed password and hands the token back under its env name", async () => {
    const { http } = door({ status: 201, body: { ok: "created", token: "npm_y" } });
    const made = await API_SIGNUPS.npm?.({
      http,
      cred: {
        username: "a@b.com",
        password: "sealed",
        codesInbox: "a@b.com",
        recoveryCodes: [],
        passkeys: [],
      },
      handle: "wrenautomation",
    });
    expect(made?.token).toEqual({ name: NPM_TOKEN, value: "npm_y" });
  });

  it("refuses to sign up without the username npm asks for beside the address", async () => {
    const { http } = door({ status: 201, body: {} });
    await expect(
      API_SIGNUPS.npm?.({
        http,
        cred: {
          username: "a@b.com",
          password: "s",
          codesInbox: "a@b.com",
          recoveryCodes: [],
          passkeys: [],
        },
        handle: null,
      }),
    ).rejects.toThrow(/username/);
  });

  it("carries its token name and the step that mints it", () => {
    expect(npm.auth).toEqual({ token: NPM_TOKEN });
    expect(npm.setup.find((s) => s.name === "token")?.makes).toEqual([NPM_TOKEN]);
  });

  it("names each token uniquely by the minute, inside npm's 40 characters", () => {
    const at = new Date("2026-09-22T19:05:00Z");
    expect(tokenName("autobrowse publish", at)).toBe("autobrowse publish 2026-09-22 19:05");
    expect(tokenName("x".repeat(60), at)).toHaveLength(40);
  });

  it("trusts a CI workflow through the page, gated as irreversible", () => {
    const trust = npm.routes.find((r) => r.path === "/packages/{package}/trust");
    expect(trust?.irreversible).toBe(true);
    expect(trust?.browser).toEqual({ flow: "npm/trusted-publisher" });
    expect(BROWSER_FLOWS["npm/trusted-publisher"]).toBe(npmTrustedPublisher);
    expect(
      trust?.request.safeParse({
        package: "p",
        owner: "o",
        repo: "r",
        workflow: ".github/workflows/x.yml",
      }).success,
    ).toBe(false);
  });

  it("makes a free org through the page, gated as irreversible", () => {
    const orgs = npm.routes.find((r) => r.path === "/orgs");
    expect(orgs?.irreversible).toBe(true);
    expect(orgs?.browser).toEqual({ flow: "npm/create-org" });
    expect(BROWSER_FLOWS["npm/create-org"]).toBe(npmCreateOrg);
    expect(orgs?.request.safeParse({ name: "@wren" }).success).toBe(false);
    expect(orgs?.request.safeParse({ name: "wrenautomation" }).success).toBe(true);
  });
});
