/** The library seams: each layer on its own, with the caller's own pieces plugged in. */
import { memoryEnvStore } from "credvault";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { missingEntries } from "../src/app/services.js";
import { defineFlow } from "../src/browser/flow.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { abilitiesOf, doer, doerFor } from "../src/do/index.js";
import { accessTokens, meta, SITES, sitesFor, x, youtube } from "../src/sites/index.js";
import { fakeBrowser } from "./fakes.js";

const jsonFetch =
  (answer: (url: URL, init?: RequestInit) => unknown) => async (url: string, init?: RequestInit) =>
    new Response(JSON.stringify(answer(new URL(url), init)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

/** Like jsonFetch, with the status the answer names. */
const statusFetch =
  (answer: (url: URL, init?: RequestInit) => { status?: number; body: unknown }) =>
  async (url: string, init?: RequestInit) => {
    const a = answer(new URL(url), init);
    return new Response(JSON.stringify(a.body), {
      status: a.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };

describe("use as a library", () => {
  it("one piece: a route's api leg with the caller's own token and http", async () => {
    const seen: string[] = [];
    const http = httpClient({
      fetch: jsonFetch((u, init) => {
        seen.push(`${new Headers(init?.headers).get("authorization")} ${u.pathname}`);
        return { items: [] };
      }),
    });
    const videos = youtube.routes.find((r) => r.path === "/youtube/v3/{resource}");
    const out = await videos?.api?.({ resource: "videos", part: "snippet" } as never, {
      token: "mine",
      http,
    });
    expect(out).toEqual({ items: [] });
    expect(seen).toEqual(["Bearer mine /youtube/v3/videos"]);
  });

  it("one piece: tokens minted from the caller's own env store, cached until they expire", async () => {
    let mints = 0;
    const http = httpClient({
      fetch: jsonFetch(() => {
        mints++;
        return { access_token: `t${mints}`, expires_in: 3600 };
      }),
    });
    const env: Record<string, string> = {
      YOUTUBE_OAUTH_CLIENT_ID: "id",
      YOUTUBE_OAUTH_CLIENT_SECRET: "s",
      YOUTUBE_REFRESH_TOKEN: "r",
    };
    let now = 0;
    const mint = accessTokens(
      http,
      (n) => env[n],
      () => now,
    );
    const spec = "oauth" in youtube.auth ? youtube.auth.oauth : null;
    expect(spec).not.toBeNull();
    expect(await mint(spec as never)).toBe("t1");
    expect(await mint(spec as never)).toBe("t1");
    now = 3600 * 1000;
    expect(await mint(spec as never)).toBe("t2");
  });

  it("one facade: the caller's sites, env, flows and sink; nothing read from the process", async () => {
    const opened: string[] = [];
    const consent = defineFlow<{ url: string }, { landed: string }>({
      site: "youtube",
      name: "oauth-consent",
      async run(_fp, i) {
        opened.push(i.url);
        return { landed: "x" };
      },
    });
    const sink = memorySink();
    const env: Record<string, string> = { YOUTUBE_OAUTH_CLIENT_ID: "id" };
    const sites = sitesFor({
      sites: [youtube],
      env: (n) => env[n],
      http: httpClient({ fetch: jsonFetch(() => ({})) }),
      flows: { "google/oauth-consent": consent as never },
      catalog: { list: async () => [], get: async () => null, proofs: async () => ({}) },
      browser: fakeBrowser([]),
      sink,
      oauthPort: 9431,
    });
    const rows = await sites.list();
    expect(rows.map((r) => r.site)).toEqual(["youtube"]);
    expect(rows[0]?.authed).toBe(false);
    const status = await sites.status("youtube");
    const step = status.setup.find((s) => s.name === "consent");
    expect(step?.blockedOn).toEqual(["YOUTUBE_OAUTH_CLIENT_SECRET"]);
    expect(step?.unrecorded).toBeUndefined();
    await expect(sites.setup("youtube", "consent")).rejects.toThrow(/YOUTUBE_OAUTH_CLIENT_SECRET/);
    expect(process.env.YOUTUBE_OAUTH_CLIENT_ID).toBeUndefined();
    expect(opened).toEqual([]);
    expect(SITES.length).toBeGreaterThan(1);
  });

  it("a token minted elsewhere: a miss reads the shared store once and retries", async () => {
    const seen: string[] = [];
    let reads = 0;
    const sites = sitesFor({
      sites: [meta],
      env: () => undefined,
      http: httpClient({
        fetch: jsonFetch((u, init) => {
          seen.push(`${new Headers(init?.headers).get("authorization")} ${u.pathname}`);
          return { data: [] };
        }),
      }),
      catalog: { list: async () => [], get: async () => null, proofs: async () => ({}) },
      browser: fakeBrowser([]),
      sink: memorySink(),
      oauthPort: 9432,
      reload: async () => {
        reads++;
        return reads === 1 ? [] : [{ name: "META_ACCESS_TOKEN", value: "laptop" }];
      },
    });
    // First miss: the store has nothing yet; the next miss within a minute does not read again.
    await expect(sites.call("meta", "GET", "/me/adaccounts", {})).rejects.toThrow(/no token/);
    await expect(sites.call("meta", "GET", "/me/adaccounts", {})).rejects.toThrow(/no token/);
    expect(reads).toBe(1);
    vi.useFakeTimers({ now: Date.now() + 61_000 });
    try {
      expect(await sites.call("meta", "GET", "/me/adaccounts", {})).toEqual({ data: [] });
    } finally {
      vi.useRealTimers();
    }
    expect(reads).toBe(2);
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatch(/^Bearer laptop \/v[\d.]+\/me\/adaccounts$/);
  });

  it("a refresh token another process rolled: read it from the store once, retry; still refused is terminal", async () => {
    const env: Record<string, string> = {
      X_CLIENT_ID: "cid",
      X_CLIENT_SECRET: "cs",
      X_REFRESH_TOKEN: "rt-old",
    };
    let stored = "rt-new";
    const refreshed: string[] = [];
    const sites = sitesFor({
      sites: [x],
      env: (n) => env[n],
      http: httpClient({
        fetch: statusFetch((u, init) => {
          if (u.pathname.endsWith("/oauth2/token")) {
            const rt = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
            refreshed.push(rt);
            return rt === "rt-new"
              ? { body: { access_token: "at", expires_in: 7200, refresh_token: "rt-new" } }
              : {
                  status: 400,
                  body: {
                    error: "invalid_request",
                    error_description: "Value passed for the token was invalid.",
                  },
                };
          }
          return { body: { data: { id: "me" } } };
        }),
      }),
      catalog: { list: async () => [], get: async () => null, proofs: async () => ({}) },
      browser: fakeBrowser([]),
      sink: memorySink(),
      oauthPort: 9433,
      reload: async (have) =>
        have("X_REFRESH_TOKEN") ? [] : [{ name: "X_REFRESH_TOKEN", value: stored }],
    });
    expect(await sites.call("x", "GET", "/2/users/me", {})).toEqual({ data: { id: "me" } });
    expect(refreshed).toEqual(["rt-old", "rt-new"]);
    stored = "rt-new";
    env.X_REFRESH_TOKEN = "rt-dead";
    const two = sitesFor({
      sites: [x],
      env: (n) => env[n],
      http: httpClient({
        fetch: statusFetch(() => ({ status: 400, body: { error: "invalid_grant" } })),
      }),
      catalog: { list: async () => [], get: async () => null, proofs: async () => ({}) },
      browser: fakeBrowser([]),
      sink: memorySink(),
      oauthPort: 9434,
      reload: async () => [{ name: "X_REFRESH_TOKEN", value: "rt-dead" }],
    });
    await expect(two.call("x", "GET", "/2/users/me", {})).rejects.toMatchObject({ status: 409 });
  });

  it("a token miss reads only the names this process lacks, never the whole store", async () => {
    const store = memoryEnvStore({ HAVE: "1", NEW_TOKEN: "t" });
    const asked: string[][] = [];
    const counted = {
      ...store,
      getMany: async (names: string[]) => {
        asked.push(names);
        return store.getMany(names);
      },
    };
    expect(await missingEntries(counted, (n) => n === "HAVE")).toEqual([
      { name: "NEW_TOKEN", value: "t" },
    ]);
    expect(await missingEntries(counted, () => true)).toEqual([]);
    expect(asked).toEqual([["NEW_TOKEN"]]);
  });

  it("the verb over the caller's own legs: no site facade, no agent", async () => {
    const ran: string[] = [];
    const verb = doer({
      llm: null,
      abilities: async () =>
        abilitiesOf({
          sites: { apis: [], rows: [] },
          workflows: [
            {
              name: "deploy-worker",
              description: "Deploy to Cloudflare Workers",
              plan: z.object({ dir: z.string() }),
              steps: [],
            } as never,
          ],
          flows: [],
        }),
      sites: async () => ["cloudflare"],
      callSite: async () => {
        throw new Error("no sites here");
      },
      runWorkflow: async (name, plan) => {
        ran.push(`${name} ${JSON.stringify(plan)}`);
        return { status: "done", steps: [], output: { url: "https://w.example" } };
      },
      runFlow: async () => null,
    });
    const out = await verb.do({ goal: "deploy-worker", inputs: { dir: "./dist" } });
    expect(out.via).toBe("workflow");
    expect(out.status).toBe("done");
    expect(out.output).toEqual({ url: "https://w.example" });
    expect(ran).toEqual(['deploy-worker {"dir":"./dist"}']);
  });

  it("the verb from parts: a narrowed world of flows and logins, no site facade", async () => {
    const ran: string[] = [];
    const browser = fakeBrowser(ran);
    const ping = defineFlow<{ n: number }, string>({
      site: "example",
      name: "ping",
      async run(_fp, i) {
        return `pong ${i.n}`;
      },
    });
    browser.on(ping, async (i) => {
      ran.push(`ping ${i.n}`);
      return `pong ${i.n}`;
    });
    const verb = doerFor({
      llm: null,
      catalog: { list: async () => [], get: async () => null, proofs: async () => ({}) },
      browser,
      sink: memorySink(),
      flows: { "example/ping": ping as never },
      logins: [],
      tools: [],
    });
    const list = await verb.abilities();
    expect(list.map((a) => `${a.kind} ${a.name}`)).toEqual(["flow example/ping"]);
    const out = await verb.do({ goal: "example/ping", inputs: { n: "1" } });
    expect(out).toMatchObject({ via: "flow", status: "done" });
    expect(out.output).toBe("pong 1");
    expect(ran).toEqual(["ping 1"]);
  });
});

describe("one login on a page the caller drives", () => {
  it("signInContext answers codes and provider credentials from the caller's stores", async () => {
    const { signInContext, LoginFailed } = await import("../src/auth/login.js");
    const { memoryCredentials } = await import("credvault");
    const { noCodes } = await import("../src/auth/codes.js");
    const { fakePage } = await import("./auth-fakes.js");
    const { fp } = fakePage({ text: [""], present: () => false });
    const credentials = memoryCredentials({
      github: { username: "w", password: "p", via: "google" },
      google: { username: "w@x.co", password: "g" },
      "google@ops": { username: "ops@x.co", password: "o" },
    });
    const cred = (await credentials.get("github")) as never;
    const ctx = signInContext({ fp, site: "github", cred, credentials, codes: noCodes });
    expect(ctx.offers("totp")).toBe(false);
    await expect(ctx.code("totp")).rejects.toBeInstanceOf(LoginFailed);
    expect((await ctx.credFor("google")).username).toBe("w@x.co");
    expect((await ctx.credFor("google", "ops@x.co")).username).toBe("ops@x.co");
    await expect(ctx.credFor("google", "nobody@x.co")).rejects.toThrow(/google@<label>/);
    expect(ctx.as(await ctx.credFor("google")).cred.username).toBe("w@x.co");
  });
});

describe("browser tiers", () => {
  it("cdp needs its URL; local and browserbase are unchanged", async () => {
    const { openSession } = await import("../src/browser/session.js");
    await expect(
      openSession("outlook-app", {
        tier: "cdp",
        profilesDir: "/tmp/x",
        artifactsDir: "/tmp/x",
        cdpUrl: null,
      }),
    ).rejects.toThrow(/BROWSER_CDP_URL/);
    const { budgetedLlm, memoryLedger, fakeLlm } = await import("../src/llm/index.js");
    const llm = budgetedLlm(fakeLlm(["ok"]), { dailyTokens: 1000, ledger: memoryLedger() });
    expect(llm.id).toBeDefined();
  });
});
