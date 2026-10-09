import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CodeKind, SignInContext } from "../src/auth/login.js";
import { passwordDomains } from "../src/auth/login.js";
import { SITE_LOGINS } from "../src/auth/sites.js";
import { signInToX, X_LOGIN_URL } from "../src/auth/x.js";
import { xOauthConsent } from "../src/browser/flows/x-oauth-consent.js";
import type { Hints } from "../src/browser/locate.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { siteFacade } from "../src/sites/facade.js";
import { SITES } from "../src/sites/index.js";
import { accessTokens, pointTo } from "../src/sites/oauth.js";
import { multipart, x, xOAuth } from "../src/sites/x.js";
import { fakePage } from "./auth-fakes.js";

const base = { username: "wrenautomation", password: "p", recoveryCodes: [], passkeys: [] };
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

describe("x sign-in", () => {
  it("is a site login bound to x.com and twitter.com whose signInHere covers the flow", () => {
    expect(SITE_LOGINS.find((l) => l.site === "x")?.signInHere?.at).toBe(X_LOGIN_URL);
    expect(passwordDomains(SITE_LOGINS, "x", base)).toEqual(["x.com", "twitter.com"]);
    expect(X_LOGIN_URL.test("https://x.com/i/flow/login?redirect_after_login=%2Fi%2Foauth2")).toBe(
      true,
    );
    expect(X_LOGIN_URL.test("https://twitter.com/login")).toBe(true);
    // The page X moved its login to in 2026-09.
    expect(
      X_LOGIN_URL.test("https://x.com/i/jf/onboarding/web?mode=login&redirect_after_login=%2F"),
    ).toBe(true);
    expect(X_LOGIN_URL.test("https://x.com/home")).toBe(false);
    expect(X_LOGIN_URL.test("https://x.com/i/oauth2/authorize?x")).toBe(false);
  });

  it("username, Next, the handle again on an unusual login, password, then the texted code", async () => {
    let url = "https://x.com/i/flow/login";
    const { fp, acts } = fakePage({
      text: [
        "Phone, email, or username Next",
        "Enter your phone number or username",
        "Enter your password Log in",
        "We texted you a verification code",
        "Home",
      ],
      present: () => true,
      url: () => url,
      onAct: (n) => {
        if (n === 8) url = "https://x.com/home";
      },
    });
    await signInToX(ctx(fp, ["sms"]));
    expect(acts.map(line)).toEqual([
      "fill /phone, email,? (address,)? ?or username|^email or username$/i",
      "click /^(next|continue)$/i",
      "fill /phone number or username/i",
      "click /^(next|continue)$/i",
      "fill /^password( show password)?$/i",
      "click /^(log in|continue)$/i",
      "fill /verification code|^code$/i",
      "click /^(next|continue)$/i",
    ]);
    expect(acts[6]?.op).toMatchObject({ kind: "fill", value: "123456" });
  });

  it("the 2026-09 page: Email or username, Continue, Password, Continue, no code", async () => {
    let url = "https://x.com/i/jf/onboarding/web?mode=login";
    const { fp, acts } = fakePage({
      text: ["Email or username Continue", "Login Password Continue", "Home"],
      present: (h) => !/phone number or username|code/i.test(String(h.name)),
      url: () => url,
      onAct: (n) => {
        if (n === 4) url = "https://x.com/home";
      },
    });
    await signInToX(ctx(fp, []));
    expect(acts.map((a) => a.op.kind)).toEqual(["fill", "click", "fill", "click"]);
    expect(acts[2]?.op).toMatchObject({ kind: "fill", value: "p" });
  });

  it("stops on a rejected password or a puzzle", async () => {
    const rejected = fakePage({
      text: ["Phone, email, or username", "Wrong password!"],
      present: (h) => !/phone number or username/i.test(String(h.name)),
    });
    await expect(signInToX(ctx(rejected.fp, []))).rejects.toThrow(/password rejected/);
    const puzzle = fakePage({
      text: ["Phone, email, or username", "Solve this puzzle so we know you're a real person"],
      present: (h) => !/phone number or username|code/i.test(String(h.name)),
      url: "https://x.com/i/flow/login",
    });
    await expect(signInToX(ctx(puzzle.fp, ["sms"]))).rejects.toThrow(/check only a person/);
  });
});

function fakeApi(answer: (u: URL, init?: RequestInit) => unknown) {
  const calls: Array<{ method: string; url: URL; headers: Headers; body: string | Uint8Array }> =
    [];
  const http = httpClient({
    fetch: async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const body = init?.body;
      calls.push({
        method: init?.method ?? "GET",
        url: u,
        headers: new Headers(init?.headers),
        body: typeof body === "string" ? body : body instanceof Uint8Array ? body : "",
      });
      return new Response(JSON.stringify(answer(u, init)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { http, calls };
}

describe("x site", () => {
  it("is registered with a catalogued consent; posts and deletes are irreversible", () => {
    expect(SITES.map((s) => s.site)).toContain("x");
    expect(BROWSER_FLOWS["x/oauth-consent"]).toBe(xOauthConsent);
    expect(xOAuth.consent).toEqual({ flow: "x/oauth-consent" });
    expect(x.routes.filter((r) => r.irreversible).map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /2/tweets",
      "DELETE /2/tweets/{id}",
      "POST /1.1/account/update_profile.json",
    ]);
  });

  it("consents with PKCE and a Basic client, keeps the refresh token under the handle too", async () => {
    const { http, calls } = fakeApi((u) =>
      u.pathname === "/2/users/me"
        ? { data: { id: "1", username: "WrenAutomation" } }
        : { access_token: "at", refresh_token: "rt1", expires_in: 7200 },
    );
    const env: Record<string, string> = { X_CLIENT_ID: "cid", X_CLIENT_SECRET: "cs" };
    const port = 9441;
    const sink = memorySink();
    const sites = siteFacade([x], {
      http,
      env: (n) => env[n],
      sink,
      runner: {
        async run(_flow, input) {
          const u = new URL((input as { url: string }).url);
          expect(u.searchParams.get("code_challenge_method")).toBe("S256");
          expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
          expect(u.searchParams.get("scope")).toBe(xOAuth.scopes.join(" "));
          await fetch(
            `http://127.0.0.1:${port}/oauth/callback?code=c&state=${u.searchParams.get("state")}`,
          );
          return { landed: "" } as never;
        },
      },
      flow: (name) => (name === "x/oauth-consent" ? xOauthConsent : null),
      oauthPort: port,
    });
    await expect(sites.setup("x", "consent")).resolves.toEqual({
      made: ["X_REFRESH_TOKEN", "X_REFRESH_TOKEN__WRENAUTOMATION"],
    });
    // One real copy; the handle's name points at it (X rolls the token on each use).
    expect(sink.values.X_REFRESH_TOKEN__WRENAUTOMATION).toBe(pointTo("X_REFRESH_TOKEN"));
    const token = calls.find((c) => c.url.pathname === "/2/oauth2/token");
    expect(token?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("cid:cs").toString("base64")}`,
    );
    const form = new URLSearchParams(String(token?.body));
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(form.get("client_secret")).toBeNull();
    expect(form.get("client_id")).toBe("cid");
  });

  it("rolls the refresh token: a mint that answers a new one keeps it", async () => {
    let n = 0;
    const { http } = fakeApi(() => ({
      access_token: `at${++n}`,
      refresh_token: `rt${n + 1}`,
      expires_in: 7200,
    }));
    const env: Record<string, string> = {
      X_CLIENT_ID: "cid",
      X_CLIENT_SECRET: "cs",
      X_REFRESH_TOKEN: "rt1",
    };
    const kept: string[][] = [];
    let clock = 0;
    const mint = accessTokens(
      http,
      (k) => env[k],
      () => clock,
      async (name, value) => {
        kept.push([name, value]);
        env[name] = value;
      },
    );
    expect(await mint(xOAuth)).toBe("at1");
    expect(kept).toEqual([["X_REFRESH_TOKEN", "rt2"]]);
    clock = 7200 * 1000;
    expect(await mint(xOAuth)).toBe("at2");
    expect(kept.at(-1)).toEqual(["X_REFRESH_TOKEN", "rt3"]);
    // An alias mints from the real copy and keeps the new token there.
    env.X_REFRESH_TOKEN__WREN = pointTo("X_REFRESH_TOKEN");
    clock *= 2;
    expect(await mint(xOAuth, "wren")).toBe("at3");
    expect(kept.at(-1)).toEqual(["X_REFRESH_TOKEN", "rt4"]);
    expect(env.X_REFRESH_TOKEN__WREN).toBe(pointTo("X_REFRESH_TOKEN"));
  });

  it("uploads an image in one multipart request and a video in chunks, waiting for processing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "x-media-"));
    const image = join(dir, "pic.png");
    await writeFile(image, new Uint8Array([1, 2, 3]));
    const video = join(dir, "clip.mp4");
    await writeFile(video, new Uint8Array(5 * 1024 * 1024).fill(7));
    let status = 0;
    const { http, calls } = fakeApi((u) => {
      if (u.pathname === "/2/media/upload/initialize") return { data: { id: "m1" } };
      if (u.pathname.endsWith("/finalize"))
        return { data: { id: "m1", processing_info: { state: "pending", check_after_secs: 0 } } };
      if (u.searchParams.get("command") === "STATUS")
        return {
          data: {
            id: "m1",
            processing_info: { state: ++status < 2 ? "in_progress" : "succeeded" },
          },
        };
      return { data: { id: "m0" } };
    });
    const sites = siteFacade([x], {
      http,
      env: () => undefined,
      sink: memorySink(),
      runner: { run: async () => ({}) as never },
      flow: () => null,
    });
    // No token: the route is refused before any upload.
    await expect(sites.call("x", "POST", "/2/media/upload", { file: image })).rejects.toThrow(
      /no token/,
    );
    const authed = siteFacade([x], {
      http,
      env: (n) => ({ X_ACCESS_TOKEN: "t" })[n],
      sink: memorySink(),
      runner: { run: async () => ({}) as never },
      flow: () => null,
    });
    await expect(authed.call("x", "POST", "/2/media/upload", { file: image })).resolves.toEqual({
      data: { id: "m0" },
    });
    const simple = calls.at(-1);
    expect(simple?.url.pathname).toBe("/2/media/upload");
    expect(simple?.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    const text = new TextDecoder().decode(simple?.body as Uint8Array);
    expect(text).toContain('name="media_category"\r\n\r\ntweet_image');
    expect(text).toContain('filename="pic.png"');

    calls.length = 0;
    await expect(authed.call("x", "POST", "/2/media/upload", { file: video })).resolves.toEqual({
      data: { id: "m1", processing_info: { state: "succeeded" } },
    });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      "POST /2/media/upload/initialize",
      "POST /2/media/upload/m1/append",
      "POST /2/media/upload/m1/append",
      "POST /2/media/upload/m1/finalize",
      "GET /2/media/upload?command=STATUS&media_id=m1",
      "GET /2/media/upload?command=STATUS&media_id=m1",
    ]);
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      media_type: "video/mp4",
      total_bytes: 5 * 1024 * 1024,
      media_category: "tweet_video",
    });
  });

  it("a post lookup reads the page, unless it asks for media fields: then the API, with both params", async () => {
    const { http, calls } = fakeApi(() => ({ data: { id: "7" } }));
    const flows: string[] = [];
    const sites = siteFacade([x], {
      http,
      env: (n) => ({ X_ACCESS_TOKEN: "t" })[n],
      sink: memorySink(),
      runner: {
        async run(flow) {
          flows.push(`${flow.site}/${flow.name}`);
          return { data: { id: "7", text: "page" } } as never;
        },
      },
      flow: (n) => BROWSER_FLOWS[n] ?? null,
    });
    await expect(sites.call("x", "GET", "/2/tweets/7", {})).resolves.toEqual({
      data: { id: "7", text: "page" },
    });
    expect(flows).toEqual(["x/post"]);
    expect(calls).toEqual([]);

    const fields = "media_key,type,duration_ms,public_metrics,non_public_metrics,organic_metrics";
    await expect(
      sites.call("x", "GET", "/2/tweets/7", {
        expansions: "attachments.media_keys",
        "media.fields": fields,
      }),
    ).resolves.toEqual({ data: { id: "7" } });
    expect(flows).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const u = calls[0]?.url;
    expect(u?.pathname).toBe("/2/tweets/7");
    expect(u?.searchParams.get("expansions")).toBe("attachments.media_keys");
    expect(u?.searchParams.get("media.fields")).toBe(fields);
    expect(u?.searchParams.get("tweet.fields")).toContain("public_metrics");
  });

  it("builds a multipart body with the fields before the file", () => {
    const { type, body } = multipart(
      { a: "1" },
      { name: "f.bin", type: "application/octet-stream", bytes: new Uint8Array([9]) },
    );
    const boundary = type.split("boundary=")[1];
    const text = new TextDecoder().decode(body);
    expect(text.startsWith(`--${boundary}\r\nContent-Disposition: form-data; name="a"`)).toBe(true);
    expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
  });

  it("walks the consent: home, authorize, Authorize app, land", async () => {
    const authorize =
      "https://x.com/i/oauth2/authorize?client_id=1&redirect_uri=http%3A%2F%2F127.0.0.1%3A9876%2Fcb&state=s";
    let url = "https://x.com/home";
    const { fp, acts } = fakePage({
      text: ["wren wants to access your X account. Authorize app"],
      present: (h) => /authorize/.test(String(h.name)),
      url: () => url,
      onAct: () => {
        url = "http://127.0.0.1:9876/cb?code=abc&state=s";
      },
    });
    fp.open = async (u) => {
      url = u;
    };
    const out = await xOauthConsent.run(fp, { url: authorize });
    expect(acts.map(line)).toEqual(["click /^(authorize app|authorize|allow)$/i"]);
    expect(out.landed).toMatch(/^http:\/\/127\.0\.0\.1:9876\/cb\?code=abc/);
  });
});
