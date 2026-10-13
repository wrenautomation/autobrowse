import { describe, expect, it } from "vitest";
import { threadsOauthConsent } from "../src/browser/flows/threads-oauth-consent.js";
import type { Hints } from "../src/browser/locate.js";
import { httpClient } from "../src/clients/http.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { runConsent, WEB_REDIRECT } from "../src/sites/oauth.js";
import { THREADS_MAX, threads, threadsOAuth } from "../src/sites/threads.js";
import type { ApiLeg } from "../src/sites/types.js";
import { fakePage } from "./auth-fakes.js";
import { fakeFetch } from "./fakes.js";

const line = (a: { op: { kind: string }; hints: Hints }) =>
  `${a.op.kind} ${a.hints.name ?? a.hints.text}`;
type Route = {
  request: { parse: (i: unknown) => unknown; safeParse: (i: unknown) => { success: boolean } };
  api: (i: unknown, leg: ApiLeg) => Promise<unknown>;
  meter?: (i: unknown) => Record<string, number>;
  irreversible?: boolean;
};
const routeOf = (method: string, path: string) =>
  threads.routes.find((r) => r.method === method && r.path === path) as unknown as Route;

describe("threads site", () => {
  it("consents in the Instagram profile through a catalogued flow; publish is irreversible", () => {
    expect(threadsOAuth.consent).toEqual({ flow: "instagram/threads-consent" });
    expect(BROWSER_FLOWS["instagram/threads-consent"]).toBe(threadsOauthConsent);
    expect(threads.setup.map((s) => s.name)).toEqual(["developer-app", "consent"]);
    expect(routeOf("POST", "/{userId}/threads_publish").irreversible).toBe(true);
    expect(routeOf("POST", "/{userId}/threads").irreversible).toBeFalsy();
  });

  it("walks the consent: threads.com, authorize, Allow, land", async () => {
    const authorize = `https://threads.net/oauth/authorize?client_id=1&redirect_uri=${encodeURIComponent(WEB_REDIRECT)}&state=s`;
    let url = "https://www.threads.com/";
    const opened: string[] = [];
    const { fp, acts } = fakePage({
      text: ["Wren is requesting access to: Continue As wrenautomation"],
      present: (h) => /continue/.test(String(h.name)),
      url: () => url,
      onAct: () => {
        url = `${WEB_REDIRECT}?code=abc&state=s`;
      },
    });
    fp.open = async (u) => {
      opened.push(u);
      url = u;
    };
    const out = await threadsOauthConsent.run(fp, { url: authorize });
    expect(opened).toEqual(["https://www.threads.com/", authorize]);
    expect(acts.map(line)).toEqual(["click /^(allow|continue)( as \\S+)?$/i"]);
    expect(out.landed).toBe(`${WEB_REDIRECT}?code=abc&state=s`);
  });

  it("exchanges the code, then trades the short token for the 60-day one", async () => {
    const calls: Array<{ method: string; url: URL; body: string }> = [];
    const http = httpClient({
      fetch: async (url: string, init?: RequestInit) => {
        const u = new URL(url);
        calls.push({ method: init?.method ?? "GET", url: u, body: String(init?.body ?? "") });
        const body =
          u.pathname === "/access_token"
            ? { access_token: "long", expires_in: 5_184_000 }
            : { access_token: "short", user_id: 7 };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const env: Record<string, string> = { THREADS_CLIENT_ID: "i", THREADS_CLIENT_SECRET: "s" };
    const out = await runConsent(threadsOAuth, {
      http,
      env: (n) => env[n],
      port: 9431,
      open: async ({ url }) => {
        const u = new URL(url);
        expect(u.host).toBe("threads.net");
        expect(u.searchParams.get("client_id")).toBe("i");
        expect(u.searchParams.get("scope")).toBe(threadsOAuth.scopes.join(","));
        expect(u.searchParams.get("redirect_uri")).toBe(WEB_REDIRECT);
        return { landed: `${WEB_REDIRECT}?code=c&state=${u.searchParams.get("state")}` };
      },
    });
    expect(out).toMatchObject({ accessToken: "long", expiresIn: 5_184_000 });
    expect(calls[0]?.url.pathname).toBe("/oauth/access_token");
    const long = calls.find((c) => c.url.pathname === "/access_token");
    expect(long?.url.host).toBe("graph.threads.net");
    expect(long?.url.searchParams.get("grant_type")).toBe("th_exchange_token");
    expect(long?.url.searchParams.get("access_token")).toBe("short");
  });

  it("posts in two calls, meters posts and replies, and holds text to 500", async () => {
    const f = fakeFetch((req) => ({
      body: req.url.pathname.endsWith("/threads_publish") ? { id: "99" } : { id: "42" },
    }));
    const leg: ApiLeg = { token: "t", http: httpClient({ fetch: f.fetch }), env: () => undefined };
    const make = routeOf("POST", "/{userId}/threads");
    const publish = routeOf("POST", "/{userId}/threads_publish");
    const input = make.request.parse({ userId: "me", media_type: "TEXT", text: "hello" });
    await expect(make.api(input, leg)).resolves.toEqual({ id: "42" });
    await expect(
      publish.api(publish.request.parse({ userId: "me", creation_id: "42" }), leg),
    ).resolves.toEqual({ id: "99" });
    expect(f.calls.map((c) => String(c.url))).toEqual([
      "https://graph.threads.net/v1.0/me/threads",
      "https://graph.threads.net/v1.0/me/threads_publish",
    ]);
    expect(String(f.calls[0]?.body)).toContain('"text":"hello"');
    expect(String(f.calls[0]?.body)).not.toContain("userId");
    expect(make.meter?.(input)).toEqual({ post: 1 });
    expect(make.meter?.({ ...(input as object), reply_to_id: "5" })).toEqual({ reply: 1 });
    expect(
      make.request.safeParse({
        userId: "me",
        media_type: "TEXT",
        text: "x".repeat(THREADS_MAX + 1),
      }).success,
    ).toBe(false);
  });
});
