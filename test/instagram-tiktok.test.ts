import { describe, expect, it, vi } from "vitest";
import { INSTAGRAM_LOGIN_URL, signInToInstagram } from "../src/auth/instagram.js";
import type { CodeKind, SignInContext } from "../src/auth/login.js";
import { SITE_LOGINS } from "../src/auth/sites.js";
import { signInToTiktok, TIKTOK_LOGIN_URL } from "../src/auth/tiktok.js";
import { countOf } from "../src/browser/flows/dialog-following.js";
import { followedOfIg } from "../src/browser/flows/instagram-act.js";
import { instagramOauthConsent } from "../src/browser/flows/instagram-oauth-consent.js";
import { followedOfThreads } from "../src/browser/flows/threads-following.js";
import { followedOfTiktok } from "../src/browser/flows/tiktok-following.js";
import { tiktokOauthConsent } from "../src/browser/flows/tiktok-oauth-consent.js";
import type { Hints } from "../src/browser/locate.js";
import { httpClient } from "../src/clients/http.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { SITES } from "../src/sites/index.js";
import { instagram, instagramOAuth } from "../src/sites/instagram.js";
import { accessTokens, runConsent } from "../src/sites/oauth.js";
import { tiktok, tiktokOAuth } from "../src/sites/tiktok.js";
import type { ApiLeg } from "../src/sites/types.js";
import { fakePage } from "./auth-fakes.js";
import { fakeFetch } from "./fakes.js";

/** The https redirect an operator registered (OAUTH_REDIRECT_URL in these tests). */
const WEB_REDIRECT = "https://example.com/oauth/callback";
const TIKTOK_REDIRECT = "https://example.com/oauth/social/tiktok";

const base = { username: "wren", password: "p", recoveryCodes: [], passkeys: [] };
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

describe("instagram sign-in", () => {
  it("is a site login whose signInHere covers the login, two-factor and challenge pages", () => {
    const login = SITE_LOGINS.find((l) => l.site === "instagram");
    expect(login?.signInHere?.at).toBe(INSTAGRAM_LOGIN_URL);
    for (const u of [
      "https://www.instagram.com/accounts/login/?next=%2Foauth%2Fauthorize",
      "https://www.instagram.com/accounts/login/two_factor?next=x",
      "https://www.instagram.com/challenge/action/abc/",
    ])
      expect(INSTAGRAM_LOGIN_URL.test(u)).toBe(true);
    expect(INSTAGRAM_LOGIN_URL.test("https://www.instagram.com/")).toBe(false);
    expect(INSTAGRAM_LOGIN_URL.test("https://www.instagram.com/oauth/authorize?x")).toBe(false);
  });

  it("username, password, the authenticator code, then declines the save prompt", async () => {
    let url = "https://www.instagram.com/accounts/login/?next=%2Foauth";
    const { fp, acts } = fakePage({
      text: [
        "Phone number, username, or email Password Log in",
        "Enter the code from your authentication app",
        "Save your login info?",
      ],
      present: (h) => !/send/i.test(String(h.name)),
      url: () => url,
      onAct: (n) => {
        if (n === 3) url = "https://www.instagram.com/accounts/login/two_factor?next=x";
        if (n === 5) url = "https://www.instagram.com/oauth/authorize?client_id=1";
      },
    });
    await signInToInstagram(ctx(fp, ["totp"]));
    expect(acts.map(line)).toEqual([
      "fill /phone number, username,? or email/i",
      "fill /^password$/i",
      "click /^log in$/i",
      "fill /security code|confirmation code|^code$/i",
      "click /^(confirm|submit|next|continue)$/i",
      "click /^not now$/i",
      "click /^not now$/i",
    ]);
  });

  it("sends and takes the emailed code on an unusual login; stops on a rejected password or a selfie check", async () => {
    let url = "https://www.instagram.com/accounts/login/";
    const emailed = fakePage({
      text: [
        "Phone number, username, or email Password",
        "We detected an unusual login attempt. Send Security Code",
        "Enter the security code we emailed",
      ],
      present: (h) => !/not now/i.test(String(h.name)),
      url: () => url,
      onAct: (n) => {
        if (n === 3) url = "https://www.instagram.com/challenge/action/1/";
        if (n === 6) url = "https://www.instagram.com/";
      },
    });
    await signInToInstagram(ctx(emailed.fp, ["email"]));
    expect(emailed.acts.map(line).slice(3)).toEqual([
      "click /send (security )?code/i",
      "fill /security code|confirmation code|^code$/i",
      "click /^(confirm|submit|next|continue)$/i",
    ]);
    expect(emailed.acts[4]?.op).toMatchObject({ kind: "fill", value: "123456" });

    const rejected = fakePage({
      text: ["Phone number, username, or email", "Sorry, your password was incorrect."],
      present: () => true,
    });
    await expect(signInToInstagram(ctx(rejected.fp, []))).rejects.toThrow(/password rejected/);

    const selfie = fakePage({
      text: [
        "Phone number, username, or email",
        "We noticed suspicious activity: confirm it's you",
      ],
      present: (h) => !/code/i.test(String(h.name)),
      url: "https://www.instagram.com/challenge/action/2/",
    });
    await expect(signInToInstagram(ctx(selfie.fp, ["email"]))).rejects.toThrow(
      /check only a person/,
    );
  });
});

describe("tiktok sign-in", () => {
  it("is a site login whose signInHere covers the login pages", () => {
    const login = SITE_LOGINS.find((l) => l.site === "tiktok");
    expect(login?.signInHere?.at).toBe(TIKTOK_LOGIN_URL);
    expect(TIKTOK_LOGIN_URL.test("https://www.tiktok.com/login/phone-or-email/email")).toBe(true);
    expect(TIKTOK_LOGIN_URL.test("https://www.tiktok.com/login?redirect_url=x")).toBe(true);
    expect(TIKTOK_LOGIN_URL.test("https://www.tiktok.com/foryou")).toBe(false);
    expect(TIKTOK_LOGIN_URL.test("https://www.tiktok.com/v2/auth/authorize/?x")).toBe(false);
  });

  it("goes to the email tab from the chooser, signs in, takes the emailed code", async () => {
    let url = "https://www.tiktok.com/login?redirect_url=x";
    let tab = "chooser";
    const { fp, acts } = fakePage({
      text: [
        "Log in to TikTok Use phone / email / username",
        "Log in with email or username",
        "Email or username Password Log in",
        "Enter the 6-digit code sent to your email",
      ],
      present: (h) => {
        const n = String(h.name ?? h.text);
        if (tab === "chooser") return /use phone|log in with email/i.test(n);
        return true;
      },
      url: () => url,
      onAct: (n) => {
        if (n === 2) tab = "form";
        if (n === 7) url = "https://www.tiktok.com/foryou";
      },
    });
    await signInToTiktok(ctx(fp, ["email"]));
    expect(acts.map(line)).toEqual([
      "click /use phone \\/ email \\/ username/i",
      "click /log in with email or username/i",
      "fill /email or username/i",
      "fill /^password$/i",
      "click /^log in$/i",
      "fill /6-digit code|verification code|enter code/i",
      "click /^(next|confirm|submit|verify|continue)$/i",
    ]);
    expect(acts[5]?.op).toMatchObject({ kind: "fill", value: "123456" });
  });

  it("stops on a rejected password; the slider puzzle is a person's", async () => {
    const rejected = fakePage({
      text: ["Email or username Password", "Account or password doesn't match our records"],
      present: () => true,
    });
    await expect(signInToTiktok(ctx(rejected.fp, []))).rejects.toThrow(/password rejected/);
    const puzzle = fakePage({
      text: ["Email or username Password", "Drag the slider to fit the puzzle"],
      present: () => true,
      url: "https://www.tiktok.com/login/phone-or-email/email",
    });
    await expect(signInToTiktok(ctx(puzzle.fp, []))).rejects.toThrow(/slider puzzle/);
  });
});

describe("instagram and tiktok consents and OAuth shapes", () => {
  it("are registered sites whose consent legs are catalogued flows", () => {
    expect(SITES.map((s) => s.site)).toEqual([
      "linkedin",
      "youtube",
      "instagram",
      "threads",
      "tiktok",
      "outlook",
      "gmail",
      "drive",
      "langfuse",
      "meta",
      "x",
      "reddit",
      "reddit-public",
      "loom",
      "npm",
      "calcom",
      "web",
      "perplexity",
      "discord",
      "fb-public",
      "connectors",
    ]);
    expect(instagramOAuth.consent).toEqual({ flow: "instagram/oauth-consent" });
    expect(tiktokOAuth.consent).toEqual({ flow: "tiktok/oauth-consent" });
    expect(BROWSER_FLOWS["instagram/oauth-consent"]).toBe(instagramOauthConsent);
    expect(BROWSER_FLOWS["tiktok/oauth-consent"]).toBe(tiktokOauthConsent);
    // Every browser leg named by a route or setup step is a catalogued flow or a workflow.
    for (const s of [instagram, tiktok]) {
      for (const r of s.routes)
        if (r.browser && "flow" in r.browser) expect(BROWSER_FLOWS[r.browser.flow]).toBeDefined();
      expect(s.setup.map((x) => x.name)).toEqual(["developer-app", "consent"]);
    }
    expect(instagram.routes.find((r) => r.path === "/{igUserId}/media_publish")?.irreversible).toBe(
      true,
    );
    expect(tiktok.routes.find((r) => r.path === "/v2/post/publish/video/init/")?.irreversible).toBe(
      true,
    );
  });

  it("reloads, never presses, when TikTok never draws #auth-btn (an app already allowed)", async () => {
    const authorize =
      "https://www.tiktok.com/v2/auth/authorize/?client_key=k&redirect_uri=http%3A%2F%2F127.0.0.1%3A9876%2Fcb&state=s";
    let url = "https://www.tiktok.com/foryou";
    const { fp, acts } = fakePage({
      text: ["wren wants to access your TikTok account"],
      present: (h) => /authorize/.test(String(h.name)),
      url: () => url,
    });
    fp.open = async (u) => {
      url = u;
    };
    let reloads = 0;
    fp.page = {
      locator: () => ({ first: () => ({ isEnabled: async () => false }) }),
      reload: async () => {
        reloads++;
        url = "http://127.0.0.1:9876/cb?code=abc&state=s";
      },
    } as unknown as typeof fp.page;
    const out = await tiktokOauthConsent.run(fp, { url: authorize });
    expect(reloads).toBe(1);
    expect(acts).toEqual([]);
    expect(out.landed).toMatch(/code=abc/);
  });

  it("walks the TikTok consent: home, authorize, Authorize, land", async () => {
    const authorize =
      "https://www.tiktok.com/v2/auth/authorize/?client_key=k&redirect_uri=http%3A%2F%2F127.0.0.1%3A9876%2Fcb&state=s";
    let url = "https://www.tiktok.com/foryou";
    const opened: string[] = [];
    const { fp, acts } = fakePage({
      text: ["wren wants to access your TikTok account"],
      present: (h) => /authorize/.test(String(h.name)),
      url: () => url,
      onAct: () => {
        url = "http://127.0.0.1:9876/cb?code=abc&state=s";
      },
    });
    fp.open = async (u) => {
      opened.push(u);
      url = u;
    };
    // #auth-btn is drawn and enabled; the walk waits for it, then presses once.
    fp.page = {
      locator: () => ({ first: () => ({ isEnabled: async () => true }) }),
      reload: async () => null,
    } as unknown as typeof fp.page;
    const out = await tiktokOauthConsent.run(fp, { url: authorize });
    expect(opened).toEqual(["https://www.tiktok.com/foryou", authorize]);
    expect(acts.map(line)).toEqual(["click /^(authorize|continue|allow)$/i"]);
    expect(out.landed).toMatch(/^http:\/\/127\.0\.0\.1:9876\/cb\?code=abc/);
  });

  it("TikTok's authorize URL carries client_key and comma-joined scopes; Instagram's code is exchanged for a long-lived token", async () => {
    const calls: Array<{ method: string; url: URL; body: string }> = [];
    const http = httpClient({
      fetch: async (url: string, init?: RequestInit) => {
        const u = new URL(url);
        calls.push({ method: init?.method ?? "GET", url: u, body: String(init?.body ?? "") });
        const body =
          u.pathname === "/access_token"
            ? { access_token: "long", expires_in: 5_184_000 }
            : { access_token: "short", refresh_token: "rt", expires_in: 3600 };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const env: Record<string, string> = {
      TIKTOK_CLIENT_KEY: "k",
      TIKTOK_CLIENT_SECRET: "s",
      INSTAGRAM_CLIENT_ID: "i",
      INSTAGRAM_CLIENT_SECRET: "is",
      OAUTH_REDIRECT_URL: WEB_REDIRECT,
      TIKTOK_REDIRECT_URL: TIKTOK_REDIRECT,
    };
    const consent = (spec: typeof tiktokOAuth, port: number) =>
      runConsent(spec, {
        http,
        env: (n) => env[n],
        port,
        open: async ({ url }) => {
          const u = new URL(url);
          if (spec === tiktokOAuth) {
            expect(u.searchParams.get("client_key")).toBe("k");
            expect(u.searchParams.get("client_id")).toBeNull();
            expect(u.searchParams.get("scope")).toBe(spec.scopes.join(","));
          }
          const state = u.searchParams.get("state");
          // Both, like Meta, refuse loopback: the browser lands on the https redirect.
          const redirect = spec === tiktokOAuth ? TIKTOK_REDIRECT : WEB_REDIRECT;
          expect(u.searchParams.get("redirect_uri")).toBe(redirect);
          return { landed: `${redirect}?code=c&state=${state}` };
        },
      });
    await expect(consent(tiktokOAuth, 9421)).resolves.toMatchObject({
      refreshToken: "rt",
      accessToken: "short",
      expiresIn: 3600,
    });
    expect(calls.at(-1)?.body).toContain("client_key=k");
    await expect(consent(instagramOAuth, 9422)).resolves.toMatchObject({
      refreshToken: "rt",
      accessToken: "long",
      expiresIn: 5_184_000,
    });
    const long = calls.at(-1);
    expect(long?.method).toBe("GET");
    expect(long?.url.host).toBe("graph.instagram.com");
    expect(long?.url.searchParams.get("grant_type")).toBe("ig_exchange_token");
    expect(long?.url.searchParams.get("access_token")).toBe("short");

    // Refresh for TikTok also names the client by client_key.
    env.TIKTOK_REFRESH_TOKEN = "rt";
    const mint = accessTokens(http, (n) => env[n]);
    expect(await mint(tiktokOAuth)).toBe("short");
    expect(calls.at(-1)?.body).toContain("client_key=k");
  });
});

describe("tiktok publish status", () => {
  const status = tiktok.routes.find(
    (r) => r.path === "/v2/post/publish/status/fetch/",
  ) as unknown as {
    request: { parse: (i: unknown) => unknown };
    api: (i: unknown, leg: ApiLeg) => Promise<{ data?: { status?: string } }>;
  };
  const legOf = (states: string[]) => {
    const f = fakeFetch(() => ({
      body: { data: { status: states.shift() ?? "PUBLISH_COMPLETE" }, error: { code: "ok" } },
    }));
    return { leg: { token: "t", http: httpClient({ fetch: f.fetch }), env: () => undefined }, f };
  };

  it("asks once without a wait, and keeps asking until done with one", async () => {
    vi.useFakeTimers();
    try {
      const once = legOf(["PROCESSING_DOWNLOAD"]);
      const a = await status.api(status.request.parse({ publish_id: "p1" }), once.leg);
      expect(a.data?.status).toBe("PROCESSING_DOWNLOAD");
      expect(once.f.calls).toHaveLength(1);
      expect(JSON.parse(once.f.calls[0]?.body ?? "{}")).toEqual({ publish_id: "p1" });

      const waits = legOf(["PROCESSING_DOWNLOAD", "PROCESSING_UPLOAD", "PUBLISH_COMPLETE"]);
      const b = status.api(status.request.parse({ publish_id: "p1", wait: 60 }), waits.leg);
      await vi.runAllTimersAsync();
      expect((await b).data?.status).toBe("PUBLISH_COMPLETE");
      expect(waits.f.calls).toHaveLength(3);

      // A publish that never lands, asked about for the longest wait: 9 reads (a flat 5 s was 25).
      const stuck = legOf(Array(40).fill("PROCESSING_UPLOAD"));
      const c = status.api(status.request.parse({ publish_id: "p1", wait: 120 }), stuck.leg);
      await vi.runAllTimersAsync();
      expect((await c).data?.status).toBe("PROCESSING_UPLOAD");
      expect(stuck.f.calls).toHaveLength(9);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("instagram following rows", () => {
  it("keeps the username and a trimmed name; drops a row with no username", () => {
    expect(followedOfIg({ username: "sam_synth", full_name: " Sam " })).toEqual({
      username: "sam_synth",
      name: "Sam",
    });
    expect(followedOfIg({ username: "kim_synth", full_name: "" })).toEqual({
      username: "kim_synth",
      name: null,
    });
    expect(followedOfIg({ full_name: "No Handle" })).toBeNull();
    expect(followedOfIg(null)).toBeNull();
  });
});

describe("tiktok following rows", () => {
  it("reads the handle from the href and the name from the first line", () => {
    expect(followedOfTiktok("/@sam_synth", "Sam Synth\n\nsam_synth\n\nFollowing")).toEqual({
      username: "sam_synth",
      name: "Sam Synth",
    });
    expect(followedOfTiktok("/@kim.synth", "kim.synth\n\nkim.synth")).toEqual({
      username: "kim.synth",
      name: null,
    });
    expect(followedOfTiktok("/@sam_synth/video/1", "x")).toBeNull();
  });
  it("reads a shown count", () => {
    expect(countOf("82")).toBe(82);
    expect(countOf("1.2K")).toBe(1200);
    expect(countOf("163M")).toBe(163_000_000);
    expect(countOf("1.0M followers")).toBe(1_000_000);
    expect(countOf("")).toBeNull();
  });
});

describe("threads following rows", () => {
  it("reads the handle from the href and the name from the second line", () => {
    expect(followedOfThreads("/@sam_synth", "sam_synth\nSam Synth\nFollow")).toEqual({
      username: "sam_synth",
      name: "Sam Synth",
    });
    expect(followedOfThreads("/@kim.synth", "kim.synth\nFollowing")).toEqual({
      username: "kim.synth",
      name: null,
    });
    expect(followedOfThreads("/@kim.synth/replies", "x")).toBeNull();
  });
});
