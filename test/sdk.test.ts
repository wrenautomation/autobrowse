/** The library seams: each layer on its own, with the caller's own pieces plugged in. */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineFlow } from "../src/browser/flow.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { abilitiesOf, doer, doerFor } from "../src/do/index.js";
import { accessTokens, SITES, sitesFor, youtube } from "../src/sites/index.js";
import { fakeBrowser } from "./fakes.js";

const jsonFetch =
  (answer: (url: URL, init?: RequestInit) => unknown) => async (url: string, init?: RequestInit) =>
    new Response(JSON.stringify(answer(new URL(url), init)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

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
      GOOGLE_OAUTH_CLIENT_ID: "id",
      GOOGLE_OAUTH_CLIENT_SECRET: "s",
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
    const env: Record<string, string> = { GOOGLE_OAUTH_CLIENT_ID: "id" };
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
    expect(step?.blockedOn).toEqual(["GOOGLE_OAUTH_CLIENT_SECRET"]);
    expect(step?.unrecorded).toBeUndefined();
    await expect(sites.setup("youtube", "consent")).rejects.toThrow(/GOOGLE_OAUTH_CLIENT_SECRET/);
    expect(process.env.GOOGLE_OAUTH_CLIENT_ID).toBeUndefined();
    expect(opened).toEqual([]);
    expect(SITES.length).toBeGreaterThan(1);
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
