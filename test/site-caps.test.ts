import type { Credential, CredentialStore } from "credvault";
import { describe, expect, it } from "vitest";
import { linkedinCompanyJobs } from "../src/browser/flows/linkedin-reach.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { memoryCaps } from "../src/sites/caps.js";
import { linkedin, SiteError, siteFacade, web, x } from "../src/sites/index.js";
import { usernameOf } from "../src/sites/wire.js";
import { fakeBrowser, fakeFetch } from "./fakes.js";

const noon = Date.UTC(2026, 8, 29, 12);

describe("daily caps", () => {
  it("takes all of a call's buckets or none, per account, and says when the day turns", () => {
    let t = noon;
    const caps = memoryCaps(() => t);
    const limits = { profile: 2, company: 1 };
    expect(caps.take("linkedin", "A@x.com", { profile: 1, company: 1 }, limits).ok).toBe(true);
    // The company bucket is full, so the profile it would also take stays free.
    expect(caps.take("linkedin", "a@x.com", { profile: 1, company: 1 }, limits)).toEqual({
      ok: false,
      bucket: "company",
      used: 1,
      cap: 1,
      retryAfter: 12 * 3600,
    });
    expect(caps.take("linkedin", "a@x.com", { profile: 1 }, limits).ok).toBe(true);
    expect(caps.take("linkedin", "a@x.com", { profile: 1 }, limits).ok).toBe(false);
    // Another account's reads never spend this one's.
    expect(caps.take("linkedin", "b@x.com", { profile: 2 }, limits).ok).toBe(true);
    expect(caps.today()["linkedin|a@x.com|profile"]).toBe(2);
    t += 12 * 3600 * 1000;
    expect(caps.take("linkedin", "a@x.com", { profile: 2 }, limits).ok).toBe(true);
  });
});

const cred = (username: string) =>
  ({ username, password: "x", recoveryCodes: [], passkeys: [] }) as unknown as Credential;
const store = (rows: Record<string, Credential>): CredentialStore => ({
  get: async (name) => rows[name] ?? null,
  put: async () => {},
  list: async () => Object.keys(rows),
});

describe("a named account", () => {
  it("is its credential's address, only for the site's own credentials", async () => {
    const s = store({ "linkedin@research": cred("r@x.com"), google: cred("g@x.com") });
    expect(await usernameOf(s, "linkedin", "LinkedIn@Research")).toBe("r@x.com");
    expect(await usernameOf(s, "linkedin", "google")).toBeNull();
    expect(await usernameOf(s, "linkedin", "linkedin@nobody")).toBeNull();
  });

  it("over its cap answers 429 with retryAfter and never runs the flow", async () => {
    const calls: string[] = [];
    const browser = fakeBrowser(calls);
    browser.on(linkedinCompanyJobs, async (i) => {
      calls.push(`jobs ${i.company}`);
      return { companyId: "1", jobs: [] };
    });
    const caps = memoryCaps(() => noon);
    const sites = siteFacade([linkedin], {
      http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      env: () => undefined,
      sink: memorySink(),
      runner: browser,
      flow: (n) => (n === "linkedin/company-jobs" ? (linkedinCompanyJobs as never) : null),
      caps,
      accountOf: async (_site, name) => (name === "linkedin@research" ? "r@x.com" : null),
    });
    for (let i = 0; i < 40; i++)
      await sites.call("linkedin", "GET", "/company/stripe/jobs", {}, "linkedin@research");
    expect(caps.today()["linkedin|r@x.com|company"]).toBe(40);
    const err = await sites
      .call("linkedin", "GET", "/company/stripe/jobs", {}, "linkedin@research")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiteError);
    expect(err).toMatchObject({ status: 429, retryAfter: 12 * 3600 });
    expect(calls.filter((c) => c.startsWith("jobs"))).toHaveLength(40);
  });
});

describe("web and x reads", () => {
  it("web needs no key: authed, both routes on the api leg, input checked", async () => {
    const sites = siteFacade([web], {
      http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      env: () => undefined,
      sink: memorySink(),
      runner: fakeBrowser([]),
      flow: () => null,
    });
    const row = await sites.status("web");
    expect(row.authed).toBe(true);
    expect(row.routes.map((r) => [r.path, r.via])).toEqual([
      ["/search", "api"],
      ["/read", "api"],
    ]);
    await expect(sites.call("web", "GET", "/search", {})).rejects.toMatchObject({ status: 400 });
  });

  it("x looks a user up by username", async () => {
    const api = fakeFetch(({ url }) => {
      expect(url.pathname).toBe("/2/users/by/username/wren_ai");
      expect(url.searchParams.get("user.fields")).toContain("public_metrics");
      return { body: { data: { id: "9", username: "wren_ai" } } };
    });
    const sites = siteFacade([x], {
      http: httpClient({ fetch: api.fetch }),
      env: (n) => (n === "X_ACCESS_TOKEN" ? "tok" : undefined),
      sink: memorySink(),
      runner: fakeBrowser([]),
      flow: () => null,
    });
    expect(await sites.call("x", "GET", "/2/users/by/username/wren_ai", {})).toEqual({
      data: { id: "9", username: "wren_ai" },
    });
    await expect(
      sites.call("x", "GET", "/2/users/by/username/not a name", {}),
    ).rejects.toMatchObject({ status: 400 });
  });
});
