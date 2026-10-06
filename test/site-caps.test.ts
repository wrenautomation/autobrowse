import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential, CredentialStore } from "credvault";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linkedinCompanyJobs } from "../src/browser/flows/linkedin-reach.js";
import { xProfile, xSearch } from "../src/browser/flows/x-read.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { fingerprint, memorySpent } from "../src/reach/key-ring.js";
import { fileCaps, memoryCaps } from "../src/sites/caps.js";
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
    // Unpaced, so forty calls at one frozen instant all get a slot.
    const sites = siteFacade([{ ...linkedin, pace: { gapMs: 0 } }], {
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

  it("the person's own account reads under its own lower caps; a work account keeps the site's", async () => {
    const browser = fakeBrowser([]);
    browser.on(linkedinCompanyJobs, async () => ({ companyId: "1", jobs: [] }));
    const caps = memoryCaps(() => noon);
    const sites = siteFacade(
      [{ ...linkedin, pace: { gapMs: 0 }, accountCaps: { linkedin: { company: 2 } } }],
      {
        http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
        env: () => undefined,
        sink: memorySink(),
        runner: browser,
        flow: (n) => (n === "linkedin/company-jobs" ? (linkedinCompanyJobs as never) : null),
        caps,
        accountOf: async (_site, name) =>
          ({ linkedin: "Me@x.com", "linkedin@research": "r@x.com" })[name] ?? null,
      },
    );
    const jobs = (who: string) => sites.call("linkedin", "GET", "/company/stripe/jobs", {}, who);
    // Named by credential or by address, it is the same account and the same two reads.
    await jobs("linkedin");
    await jobs("me@x.com");
    await expect(jobs("linkedin")).rejects.toMatchObject({ status: 429 });
    for (let i = 0; i < 3; i++) await jobs("linkedin@research");
    expect(caps.today()["linkedin|r@x.com|company"]).toBe(3);
  });

  it("linkedin's own profile reads at the alt's pace and sends nothing (2026-10-06)", () => {
    expect(linkedin.accountCaps?.linkedin).toEqual({
      profile: 20,
      search: 5,
      company: 10,
      connect: 0,
      message: 0,
      inbox: 0,
      network: 0,
      withdraw: 0,
      notifications: 0,
      audience: 0,
      activity: 10,
    });
    expect(linkedin.caps).toMatchObject({ company: 40 });
  });
});

describe("the exa budget on web", () => {
  afterEach(() => vi.unstubAllGlobals());
  const PAGE =
    "# Avery Quinlan\n\nRecruiter at Northwind\n\n## Experience\n\n### Recruiter - Northwind (Current)";
  const facade = (caps: ReturnType<typeof memoryCaps>) => {
    vi.stubGlobal(
      "fetch",
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/contents")
              ? { results: [{ text: PAGE }], statuses: [{ status: "success", source: "cached" }] }
              : { results: [{ url: "https://www.linkedin.com/in/avery", text: PAGE }] },
          ),
        ),
    );
    return siteFacade([web], {
      http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      env: (n) => (n === "EXA_API_KEY" ? "k" : undefined),
      sink: memorySink(),
      runner: fakeBrowser([]),
      flow: () => null,
      caps,
    });
  };

  it("meters mills: a cache read 1, a people or company search 7; a bad URL spends none", async () => {
    const caps = memoryCaps(() => noon);
    const sites = facade(caps);
    const url = "https://www.linkedin.com/in/avery";
    expect(await sites.call("web", "GET", "/linkedin/profile", { url })).toMatchObject({
      name: "Avery Quinlan",
      vanity: "avery",
    });
    await sites.call("web", "GET", "/people", { q: "recruiters at Northwind" });
    await expect(
      sites.call("web", "GET", "/linkedin/company", { url: "https://acme.com/about" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(caps.today()["web|web|exa"]).toBe(8);
  });

  it("a firm search is 7 mills whatever n, and n over 25 is refused unspent", async () => {
    const caps = memoryCaps(() => noon);
    const sites = facade(caps);
    const out = await sites.call<{ results: unknown[] }>("web", "GET", "/exa/companies", {
      q: "staffing agency in Austin",
      n: 25,
    });
    expect(out.results).toHaveLength(1);
    await expect(
      sites.call("web", "GET", "/exa/companies", { q: "x", n: 26 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(caps.today()["web|web|exa"]).toBe(7);
  });

  it("the cap is 330 per live key: a second key doubles it, a spent one does not count", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ results: [] })));
    const caps = memoryCaps(() => noon);
    caps.take("web", "web", { exa: 400 }, { exa: 1000 });
    const spent = memorySpent();
    const keys: Record<string, string> = {
      NUM_EXA: "2",
      EXA_API_KEY_1: "synthetic-a",
      EXA_API_KEY_2: "synthetic-b",
    };
    const sites = siteFacade([web], {
      http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      env: (n) => keys[n],
      sink: memorySink(),
      runner: fakeBrowser([]),
      flow: () => null,
      caps,
      spent,
      now: () => noon,
    });
    await sites.call("web", "GET", "/people", { q: "q" });
    spent.mark(fingerprint("synthetic-b"), noon + 1000);
    await expect(sites.call("web", "GET", "/people", { q: "q" })).rejects.toMatchObject({
      status: 429,
    });
  });

  it("past 330 mills a day the call is refused, never sent", async () => {
    const caps = memoryCaps(() => noon);
    caps.take("web", "web", { exa: 325 }, { exa: 330 });
    const sites = facade(caps);
    await expect(sites.call("web", "GET", "/people", { q: "q" })).rejects.toMatchObject({
      status: 429,
    });
    expect(caps.today()["web|web|exa"]).toBe(325);
  });
});

describe("web and x reads", () => {
  it("web needs no key: authed, its api routes on the api leg, input checked", async () => {
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
      ["/people", "api"],
      ["/companies", "api"],
      ["/exa/companies", "api"],
      ["/linkedin/profile", "api"],
      ["/linkedin/company", "api"],
      ["/read", "api"],
      ["/google", "none"], // a browser leg; this fake runner has no flows
    ]);
    await expect(sites.call("web", "GET", "/search", {})).rejects.toMatchObject({ status: 400 });
  });

  it("x reads go to the signed-in page even with a token, so they never pay", async () => {
    const api = fakeFetch(() => {
      throw new Error("the API was called");
    });
    const browser = fakeBrowser([]);
    browser.on(xProfile, async ({ username }) => ({
      data: {
        id: "9",
        username,
        name: "Wren",
        public_metrics: { followers_count: 1, following_count: 2, tweet_count: 3 },
      },
    }));
    const sites = siteFacade([x], {
      http: httpClient({ fetch: api.fetch }),
      env: (n) => (n === "X_ACCESS_TOKEN" ? "tok" : undefined),
      sink: memorySink(),
      runner: browser,
      flow: (n) => (n === "x/profile" ? (xProfile as never) : null),
    });
    const row = (await sites.status("x")).routes.find((r) => r.path.includes("by/username"));
    expect(row?.via).toBe("browser");
    expect(await sites.call("x", "GET", "/2/users/by/username/wren_ai", {})).toMatchObject({
      data: { id: "9", username: "wren_ai" },
    });
    expect(api.calls).toHaveLength(0);
    await expect(
      sites.call("x", "GET", "/2/users/by/username/not a name", {}),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("pace", () => {
  it("books one slot per account a gap plus jitter apart, and refuses past the longest wait", () => {
    let t = noon;
    const caps = memoryCaps(
      () => t,
      () => 0.5,
    );
    const pace = { gapMs: 5_000, jitterMs: 10_000, maxWaitMs: 20_000 };
    expect(caps.slot("x", "A@x.com", pace)).toEqual({ ok: true, waitMs: 0 });
    // Next slot is 5s + half of 10s after the first.
    expect(caps.slot("x", "a@x.com", pace)).toEqual({ ok: true, waitMs: 10_000 });
    expect(caps.slot("x", "a@x.com", pace)).toEqual({ ok: true, waitMs: 20_000 });
    expect(caps.slot("x", "a@x.com", pace)).toEqual({ ok: false, waitMs: 30_000, retryAfter: 30 });
    // Another account, and the same account on another site, have their own slots.
    expect(caps.slot("x", "b@x.com", pace).waitMs).toBe(0);
    expect(caps.slot("linkedin", "a@x.com", pace).waitMs).toBe(0);
    // A booked slot outlives the day turning.
    t = Date.UTC(2026, 8, 29, 23, 59, 59);
    const late = caps.slot("x", "c@x.com", pace);
    expect(late.waitMs).toBe(0);
    t += 1_000;
    expect(caps.slot("x", "c@x.com", pace)).toEqual({ ok: true, waitMs: 9_000 });
  });

  it("the facade waits for the slot before the browser runs, and 429s a long queue", async () => {
    const order: string[] = [];
    const browser = fakeBrowser([]);
    browser.on(xSearch, async () => {
      order.push("run");
      return { data: [], meta: { result_count: 0 } };
    });
    const sites = siteFacade([{ ...x, pace: { gapMs: 60_000, maxWaitMs: 90_000 } }], {
      http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      env: () => undefined,
      sink: memorySink(),
      runner: browser,
      flow: (n) => (n === "x/search" ? (xSearch as never) : null),
      caps: memoryCaps(() => noon),
      sleep: async (ms) => {
        order.push(`sleep ${ms}`);
      },
    });
    const search = () => sites.call("x", "GET", "/2/tweets/search/recent", { query: "wren" });
    await search();
    await search();
    expect(order).toEqual(["run", "sleep 60000", "run"]);
    // The next slot is two minutes out: past the longest wait, so a 429 and nothing runs.
    const err = await search().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, retryAfter: 120 });
    expect(order).toHaveLength(3);
    expect(String((err as Error).message)).toMatch(/retry after \d+s/);
  });
});

describe("who spent a cap", () => {
  const facade = (caps: ReturnType<typeof memoryCaps>, calls: string[], fail = false) => {
    const browser = fakeBrowser(calls);
    browser.on(linkedinCompanyJobs, async (i) => {
      calls.push(`jobs ${i.company}`);
      if (fail) throw new Error("page changed");
      return { companyId: "1", jobs: [] };
    });
    return siteFacade([{ ...linkedin, pace: { gapMs: 0 } }], {
      http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      env: () => undefined,
      sink: memorySink(),
      runner: browser,
      flow: (n) => (n === "linkedin/company-jobs" ? (linkedinCompanyJobs as never) : null),
      caps,
      now: () => noon,
      accountOf: async (_site, name) =>
        name === "linkedin@research" ? "r@x.com" : name === "linkedin" ? "w@x.com" : null,
    });
  };

  it("William's own LinkedIn past its 10 company reads: a 429 that spends nothing and runs nothing", async () => {
    const calls: string[] = [];
    const caps = memoryCaps(() => noon);
    const sites = facade(caps, calls);
    const read = () =>
      sites.call("linkedin", "GET", "/company/stripe/jobs", {}, "linkedin", {
        caller: "wren:demo",
      });
    for (let i = 0; i < 10; i++) await read();
    calls.length = 0;
    const err = await read().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429 });
    expect(calls).toEqual([]);
    expect(caps.today()).toMatchObject({ "linkedin|w@x.com|company": 10 });
    expect(caps.calls().at(-1)).toMatchObject({
      account: "w@x.com",
      caller: "wren:demo",
      outcome: "capped",
      bucket: "company",
    });
  });

  it("notes each metered call with its caller, route template and outcome", async () => {
    const caps = memoryCaps(() => noon);
    await facade(caps, []).call(
      "linkedin",
      "GET",
      "/company/stripe/jobs",
      {},
      "linkedin@research",
      {
        caller: "wren:research",
        invocation: "inv_1",
      },
    );
    await facade(caps, [], true)
      .call("linkedin", "GET", "/company/acme/jobs", {}, "linkedin@research")
      .catch(() => null);
    const rows = caps.calls("2026-09-29");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      at: new Date(noon).toISOString(),
      site: "linkedin",
      account: "r@x.com",
      route: "GET /company/{company}/jobs",
      use: { company: 1 },
      caller: "wren:research",
      invocation: "inv_1",
      outcome: "ok",
    });
    // The path a company or person is named in never lands in the ledger.
    expect(JSON.stringify(rows)).not.toMatch(/stripe|acme/);
    expect(rows[1]).toMatchObject({ caller: null, outcome: "failed" });
    const report = facade(caps, []).caps(undefined, "linkedin");
    expect(report).toMatchObject({ day: "2026-09-29", used: { "linkedin|r@x.com|company": 2 } });
    expect(report.calls).toHaveLength(2);
    expect(facade(caps, []).caps("2026-09-28").calls).toEqual([]);
  });

  it("a failed metered read is a terminal 502: a durable retry would spend a read per try", async () => {
    const caps = memoryCaps(() => noon);
    const err = await facade(caps, [], true)
      .call("linkedin", "GET", "/company/acme/jobs", {}, "linkedin@research")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiteError);
    expect(err).toMatchObject({ status: 502 });
    expect((err as Error).message).toMatch(
      /GET \/company\/\{company\}\/jobs failed after spending a read/,
    );
    expect(caps.today()).toEqual({ "linkedin|r@x.com|company": 1 });
  });
});

describe("the caps ledger on disk", () => {
  it("writes a 0600 file per day beside the caps file, reads past a torn line, drops two-week-old days", () => {
    const dir = mkdtempSync(join(tmpdir(), "caps-"));
    const log = join(dir, "caps-calls");
    mkdirSync(log);
    writeFileSync(join(log, "2026-09-01.jsonl"), "{}\n");
    writeFileSync(join(log, "2026-09-20.jsonl"), "{}\n");
    const caps = fileCaps(join(dir, "caps.json"), () => noon);
    const row = {
      at: new Date(noon).toISOString(),
      site: "linkedin",
      account: "r@x.com",
      route: "GET /company/{handle}",
      use: { company: 1 },
      caller: "wren:demo",
      outcome: "ok" as const,
    };
    caps.note(row);
    appendFileSync(join(log, "2026-09-29.jsonl"), '{"at":"torn');
    expect(caps.calls()).toEqual([row]);
    expect(statSync(join(log, "2026-09-29.jsonl")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(log, "2026-09-01.jsonl"))).toBe(false);
    expect(existsSync(join(log, "2026-09-20.jsonl"))).toBe(true);
    // A new instance (a restart) reads the same day.
    expect(fileCaps(join(dir, "caps.json"), () => noon).calls("2026-09-29")).toEqual([row]);
  });
});
