import { describe, expect, it } from "vitest";
import { FACEBOOK_LOGIN_URL, signInToFacebook } from "../src/auth/facebook.js";
import type { CodeKind, SignInContext } from "../src/auth/login.js";
import { passwordDomains } from "../src/auth/login.js";
import { SITE_LOGINS } from "../src/auth/sites.js";
import { facebookOauthConsent } from "../src/browser/flows/facebook-oauth-consent.js";
import type { Hints } from "../src/browser/locate.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import type { Approval } from "../src/gates/payment.js";
import { memoryCaps } from "../src/sites/caps.js";
import { siteFacade } from "../src/sites/facade.js";
import { meta, metaOAuth } from "../src/sites/meta.js";
import { runConsent, WEB_REDIRECT } from "../src/sites/oauth.js";
import { fakePage } from "./auth-fakes.js";

const base = { username: "w@x.dev", password: "p", recoveryCodes: [], passkeys: [] };
const ctx = (fp: SignInContext["fp"], kinds: CodeKind[]): SignInContext => ({
  fp,
  cred: base,
  code: async (kind) => (kinds.includes(kind) ? "123456" : Promise.reject(new Error("none"))),
  offers: (kind) => kinds.includes(kind),
  inbox: () => null,
  credFor: async () => base,
  as: () => ctx(fp, kinds),
});
const line = (a: { op: { kind: string }; hints: Hints }) =>
  `${a.op.kind} ${a.hints.name ?? a.hints.text}`;

describe("facebook sign-in", () => {
  it("is a site login bound to Meta's hosts, whose signInHere covers the checkpoints", () => {
    const login = SITE_LOGINS.find((l) => l.site === "facebook");
    expect(login?.signInHere?.at).toBe(FACEBOOK_LOGIN_URL);
    expect(passwordDomains(SITE_LOGINS, "facebook", base)).toEqual([
      "facebook.com",
      "meta.com",
      "fb.com",
    ]);
    for (const u of [
      "https://www.facebook.com/login/?next=https%3A%2F%2Fwww.facebook.com%2Fv23.0%2Fdialog%2Foauth",
      "https://www.facebook.com/checkpoint/?next=x",
      "https://www.facebook.com/two_step_verification/authentication/?next=x",
    ])
      expect(FACEBOOK_LOGIN_URL.test(u)).toBe(true);
    expect(FACEBOOK_LOGIN_URL.test("https://www.facebook.com/")).toBe(false);
    expect(FACEBOOK_LOGIN_URL.test("https://www.facebook.com/v23.0/dialog/oauth?x")).toBe(false);
  });

  it("email, password, the authenticator code, then declines the save prompt", async () => {
    let url = "https://www.facebook.com/login/?next=x";
    const { fp, acts } = fakePage({
      text: [
        "Email or phone number Password Log in",
        "Enter the 6-digit code from your authentication app",
        "Save browser?",
      ],
      present: () => true,
      url: () => url,
      onAct: (n) => {
        if (n === 3) url = "https://www.facebook.com/two_step_verification/two_factor/?next=x";
        if (n === 5) url = "https://www.facebook.com/v23.0/dialog/oauth?client_id=1";
      },
    });
    await signInToFacebook(ctx(fp, ["totp"]));
    expect(acts.map(line)).toEqual([
      "fill /email( address)? or phone( number)?|^email$/i",
      "fill /^password$/i",
      "click /^log in$/i",
      "fill /^code$|login code|6-digit|security code/i",
      "click /^(continue|submit|next|confirm)$/i",
      "click /^(don.t save|not now|skip)$/i",
      "click /^(don.t save|not now|skip)$/i",
    ]);
    expect(acts[3]?.op).toMatchObject({ kind: "fill", value: "123456" });
  });

  it("stops on a rejected password or a check only a person can pass", async () => {
    const rejected = fakePage({
      text: ["Email or phone number", "The password you've entered is incorrect."],
      present: () => true,
    });
    await expect(signInToFacebook(ctx(rejected.fp, []))).rejects.toThrow(/password rejected/);
    const selfie = fakePage({
      text: ["Email or phone number", "Confirm your identity: upload a photo of yourself"],
      present: (h) => !/code/i.test(String(h.name)),
      url: "https://www.facebook.com/checkpoint/1/",
    });
    await expect(signInToFacebook(ctx(selfie.fp, ["sms"]))).rejects.toThrow(/check only a person/);
  });
});

describe("meta site", () => {
  it("is registered, its consent is a catalogued flow, and its spends routes are marked", () => {
    expect(metaOAuth.consent).toEqual({ flow: "facebook/oauth-consent" });
    expect(BROWSER_FLOWS["facebook/oauth-consent"]).toBe(facebookOauthConsent);
    expect(meta.setup.map((x) => x.name)).toEqual(["developer-app", "consent"]);
    const spends = meta.routes.filter((r) => r.spends).map((r) => `${r.method} ${r.path}`);
    expect(spends).toEqual([
      "POST /act_{adAccountId}/campaigns",
      "POST /act_{adAccountId}/adsets",
      "POST /act_{adAccountId}/ads",
      "POST /{objectId}",
    ]);
    for (const p of ["/{pageId}/feed", "/{pageId}/photos", "/{igUserId}/media_publish"])
      expect(meta.routes.find((r) => r.path === p)?.irreversible).toBe(true);
  });

  function facade(approve: ((a: Approval) => Promise<boolean>) | null) {
    const calls: Array<{ method: string; url: URL; auth: string | null; body: string }> = [];
    const http = httpClient({
      fetch: async (url: string, init?: RequestInit) => {
        const u = new URL(url);
        calls.push({
          method: init?.method ?? "GET",
          url: u,
          auth: new Headers(init?.headers).get("authorization"),
          body: String(init?.body ?? ""),
        });
        const body =
          u.pathname === "/v23.0/111"
            ? { access_token: "page-token" }
            : u.searchParams.get("fields") === "page"
              ? { id: "9", page: { id: "111" } }
              : { id: "9", ok: true };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const env: Record<string, string> = { META_ACCESS_TOKEN: "user-token" };
    const asked: Approval[] = [];
    const sites = siteFacade([meta], {
      http,
      env: (n) => env[n],
      sink: memorySink(),
      runner: { run: async () => ({}) as never },
      flow: () => null,
      approve: approve
        ? async (a) => {
            asked.push(a);
            return approve(a);
          }
        : null,
    });
    return { sites, calls, asked };
  }

  it("asks before a request that starts delivery, with the budget as the amount; a paused one just runs", async () => {
    const { sites, calls, asked } = facade(async () => true);
    await sites.call("meta", "POST", "/act_123/campaigns", {
      name: "wren",
      objective: "OUTCOME_LEADS",
    });
    expect(asked).toEqual([]);
    expect(calls.at(-1)?.url.pathname).toBe("/v23.0/act_123/campaigns");
    expect(JSON.parse(calls.at(-1)?.body ?? "{}")).toMatchObject({
      name: "wren",
      status: "PAUSED",
      special_ad_categories: [],
    });
    await sites.call("meta", "POST", "/act_123/adsets", {
      name: "set",
      campaign_id: "9",
      status: "ACTIVE",
      daily_budget: 2000,
      targeting: { geo_locations: { countries: ["US"] } },
    });
    expect(asked).toEqual([
      {
        what: "POST /act_123/adsets on meta, which spends",
        url: "https://graph.facebook.com/act_123/adsets",
        site: "meta",
        amount: { value: 20, currency: "", per: "day" },
      },
    ]);
    await sites.call("meta", "POST", "/9", { status: "ACTIVE" });
    expect(asked.at(-1)).not.toHaveProperty("amount"); // no budget on the request: an unknown amount
  });

  it("reads the account, ad sets, ads and pixels an audit needs, never asking", async () => {
    const { sites, calls, asked } = facade(null);
    for (const p of ["/act_123", "/act_123/adsets", "/act_123/ads", "/act_123/adspixels"])
      await sites.call("meta", "GET", p, {});
    expect(asked).toEqual([]);
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/v23.0/act_123",
      "/v23.0/act_123/adsets",
      "/v23.0/act_123/ads",
      "/v23.0/act_123/adspixels",
    ]);
    expect(calls[0]?.url.searchParams.get("fields")).toContain("account_status");
    expect(calls[1]?.url.searchParams.get("fields")).toContain("learning_stage_info");
    expect(calls[3]?.url.searchParams.get("fields")).toContain("last_fired_time");
    await sites.call("meta", "GET", "/act_123/insights", {
      time_range: '{"since":"2026-09-01","until":"2026-09-30"}',
    });
    expect(calls.at(-1)?.url.searchParams.get("date_preset")).toBeNull();
    expect(calls.at(-1)?.url.searchParams.get("time_range")).toContain("2026-09-01");
  });

  it("refuses to spend on a no, or with nobody to ask; the API is never called", async () => {
    const no = facade(async () => false);
    await expect(
      no.sites.call("meta", "POST", "/9", { status: "ACTIVE", daily_budget: 500 }),
    ).rejects.toThrow(/refused/);
    expect(no.calls).toEqual([]);
    const nobody = facade(null);
    await expect(nobody.sites.call("meta", "POST", "/9", { status: "ACTIVE" })).rejects.toThrow(
      /no channel to ask on/,
    );
    expect(nobody.calls).toEqual([]);
    const rows = await nobody.sites.status("meta");
    expect(rows.routes.find((r) => r.path === "/{objectId}")?.spends).toBe(true);
    expect(rows.routes.find((r) => r.path === "/me")?.spends).toBe(false);
  });

  it("posts to a Page with the Page's own token, read with the user's and never kept", async () => {
    const { sites, calls } = facade(async () => true);
    await sites.call("meta", "POST", "/111/feed", { message: "hello" });
    expect(calls.map((c) => [c.method, c.url.pathname, c.auth])).toEqual([
      ["GET", "/v23.0/111", "Bearer user-token"],
      ["POST", "/v23.0/111/feed", "Bearer page-token"],
    ]);
    expect(calls[0]?.url.searchParams.get("fields")).toBe("access_token");
  });

  it("makes an instant form with the Page token and reads its leads by finding the Page first", async () => {
    const { sites, calls } = facade(null);
    await sites.call("meta", "POST", "/111/leadgen_forms", {
      name: "founders",
      questions: [{ type: "EMAIL" }, { type: "FULL_NAME" }],
      privacy_policy: { url: "https://wren.test/privacy" },
    });
    expect(calls.at(-1)?.url.pathname).toBe("/v23.0/111/leadgen_forms");
    expect(calls.at(-1)?.auth).toBe("Bearer page-token");
    expect(JSON.parse(calls.at(-1)?.body ?? "{}")).toMatchObject({ locale: "EN_US" });
    calls.length = 0;
    // The form's Page is looked up, then the Page's token, then the leads with it.
    await sites.call("meta", "GET", "/9/leads", {});
    expect(calls.map((c) => [c.url.pathname, c.auth])).toEqual([
      ["/v23.0/9", "Bearer user-token"],
      ["/v23.0/111", "Bearer user-token"],
      ["/v23.0/9/leads", "Bearer page-token"],
    ]);
  });

  it("exchanges the code for a long-lived token naming the client id", async () => {
    const calls: Array<{ method: string; url: URL; body: string }> = [];
    const http = httpClient({
      fetch: async (url: string, init?: RequestInit) => {
        const u = new URL(url);
        calls.push({ method: init?.method ?? "GET", url: u, body: String(init?.body ?? "") });
        const body =
          u.searchParams.get("grant_type") === "fb_exchange_token"
            ? { access_token: "long", expires_in: 5_184_000 }
            : { access_token: "short", expires_in: 3600 };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const env: Record<string, string> = { META_CLIENT_ID: "app", META_CLIENT_SECRET: "s" };
    await expect(
      runConsent(metaOAuth, {
        http,
        env: (n) => env[n],
        open: async ({ url }) => {
          const u = new URL(url);
          expect(u.origin + u.pathname).toBe("https://www.facebook.com/v23.0/dialog/oauth");
          expect(u.searchParams.get("scope")).toBe(metaOAuth.scopes.join(","));
          // Meta enforces HTTPS: nothing listens, the browser answers and the flow returns the URL.
          expect(u.searchParams.get("redirect_uri")).toBe(WEB_REDIRECT);
          return { landed: `${WEB_REDIRECT}?code=c&state=${u.searchParams.get("state")}#_=_` };
        },
      }),
    ).resolves.toEqual({ refreshToken: null, accessToken: "long", expiresIn: 5_184_000 });
    const long = calls.at(-1);
    expect(long?.method).toBe("GET");
    expect(long?.url.searchParams.get("client_id")).toBe("app");
    expect(long?.url.searchParams.get("fb_exchange_token")).toBe("short");
  });

  it("walks the consent: home, authorize, Continue as, Continue, land", async () => {
    const authorize =
      "https://www.facebook.com/v23.0/dialog/oauth?client_id=1&redirect_uri=http%3A%2F%2F127.0.0.1%3A9876%2Fcb&state=s";
    let url = "https://www.facebook.com/";
    let clicks = 0;
    const { fp, acts } = fakePage({
      text: ["Continue as William", "wren will receive: your Pages", "done"],
      present: (h) => /continue/.test(String(h.name)),
      url: () => url,
      onAct: () => {
        clicks++;
        if (clicks === 2) url = "http://127.0.0.1:9876/cb?code=abc&state=s";
      },
    });
    fp.open = async (u) => {
      url = u;
    };
    const out = await facebookOauthConsent.run(fp, { url: authorize });
    expect(acts).toHaveLength(2);
    expect(out.landed).toMatch(/^http:\/\/127\.0\.0\.1:9876\/cb\?code=abc/);
  });
});

describe("meta GET /instagram/{username}", () => {
  const graphError = (code: number, error_subcode: number | undefined, message: string) => ({
    error: { code, ...(error_subcode ? { error_subcode } : {}), message },
  });
  /** `answer` is what Graph says to the business_discovery call; the Page lookup is always the same. */
  function setup(answer: (fields: string) => { status: number; body: unknown }, token = "ig-tok") {
    const calls: URL[] = [];
    const http = httpClient({
      attempts: 1,
      fetch: async (url: string) => {
        const u = new URL(url);
        calls.push(u);
        const out =
          u.pathname === "/v23.0/me/accounts"
            ? {
                status: 200,
                body: {
                  data: [{ id: "p1" }, { id: "p2", instagram_business_account: { id: "1784" } }],
                },
              }
            : answer(u.searchParams.get("fields") ?? "");
        return new Response(JSON.stringify(out.body), { status: out.status });
      },
    });
    const caps = memoryCaps(() => new Date("2026-10-05T12:00:00Z").getTime());
    const sites = siteFacade([meta], {
      http,
      env: (n) => (n === "META_ACCESS_TOKEN" ? token : undefined),
      sink: memorySink(),
      runner: { run: async () => ({}) as never },
      flow: () => null,
      caps,
    });
    return { sites, calls, caps };
  }

  it("asks one business_discovery call as our Instagram account and splits profile from media", async () => {
    const { sites, calls } = setup(() => ({
      status: 200,
      body: {
        business_discovery: {
          id: "5",
          username: "acme.recruit",
          followers_count: 10,
          media: {
            data: [
              { id: "m1", caption: "We are hiring", permalink: "https://www.instagram.com/p/x/" },
            ],
          },
        },
        id: "1784",
      },
    }));
    const out = await sites.call("meta", "GET", "/instagram/acme.recruit", {});
    expect(out).toEqual({
      found: true,
      profile: { id: "5", username: "acme.recruit", followers_count: 10 },
      media: [{ id: "m1", caption: "We are hiring", permalink: "https://www.instagram.com/p/x/" }],
    });
    expect(calls.at(-1)?.pathname).toBe("/v23.0/1784");
    const fields = calls.at(-1)?.searchParams.get("fields") ?? "";
    expect(fields).toMatch(
      /^business_discovery\.username\(acme\.recruit\)\{id,ig_id,username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count,media\.limit\(25\)\{id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count\}\}$/,
    );
  });

  it("looks the Instagram account up once per token, and counts every read", async () => {
    const { sites, calls, caps } = setup(
      () => ({ status: 200, body: { business_discovery: { id: "5" } } }),
      "tok-cache",
    );
    expect(await sites.call("meta", "GET", "/instagram/a_b", {})).toMatchObject({
      found: true,
      media: [],
    });
    await sites.call("meta", "GET", "/instagram/c.d", {});
    expect(calls.filter((u) => u.pathname === "/v23.0/me/accounts")).toHaveLength(1);
    expect(caps.today()["meta|meta|reads"]).toBe(2);
    expect(meta.caps).toEqual({ reads: 300 });
  });

  it("answers found: false for an unknown name or a personal account (Graph 110 / 2207013)", async () => {
    const { sites } = setup(
      () => ({
        status: 400,
        body: graphError(110, 2207013, "The user with username: nobody cannot be found."),
      }),
      "tok-missing",
    );
    expect(await sites.call("meta", "GET", "/instagram/nobody", {})).toEqual({
      found: false,
      reason: "The user with username: nobody cannot be found. (graph code 110/2207013)",
    });
  });

  it("turns a Graph rate limit into a 429 with retryAfter, for each rate code", async () => {
    for (const code of [4, 17, 32, 613, 80002]) {
      const { sites } = setup(
        () => ({ status: 400, body: graphError(code, undefined, "slow down") }),
        `tok-rate-${code}`,
      );
      await expect(sites.call("meta", "GET", "/instagram/acme", {})).rejects.toMatchObject({
        status: 429,
        retryAfter: 3600,
        message: expect.stringMatching(/retry after 3600s$/),
      });
    }
  });

  it("keeps any other Graph error an error, with its code, and refuses a bad username before any call", async () => {
    const { sites, calls } = setup(
      () => ({ status: 400, body: graphError(190, 463, "expired") }),
      "tok-other",
    );
    await expect(sites.call("meta", "GET", "/instagram/acme", {})).rejects.toThrow(
      /HTTP 400 graph code 190\/463/,
    );
    const before = calls.length;
    for (const bad of ["a b", "x".repeat(31), "a/b", "a;b"])
      await expect(
        sites.call("meta", "GET", `/instagram/${encodeURIComponent(bad)}`, {}),
      ).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(before);
  });

  it("refuses the 301st read of the day with a 429 before any call", async () => {
    const { sites, calls, caps } = setup(
      () => ({ status: 200, body: { business_discovery: { id: "5" } } }),
      "tok-cap",
    );
    for (let i = 0; i < 300; i += 1) caps.take("meta", "meta", { reads: 1 }, { reads: 300 });
    await expect(sites.call("meta", "GET", "/instagram/acme", {})).rejects.toMatchObject({
      status: 429,
    });
    expect(calls).toEqual([]);
  });
});
