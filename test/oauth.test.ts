/**
 * The `./oauth` piece against fake endpoints: no network, synthetic ids. Most cases are wren's own
 * (core, mail, social connect, connected apps), so the wire stays what wren sends today.
 */
import { describe, expect, it } from "vitest";
import {
  type AppSpec,
  accessOf,
  appConnectUrl,
  appExchange,
  appInTenant,
  appRefresh,
  authorizeEndpoint,
  authorizeUrl,
  CONSUMER_GOOGLE,
  claimsOf,
  exchangeCode,
  GMAIL_READ,
  GMAIL_SEND,
  GRAPH_READ,
  GRAPH_SEND,
  graphScopes,
  LINKEDIN_VERSION,
  mailConnectUrl,
  mailConsentUrl,
  mailExchange,
  mailRefresh,
  metaPages,
  metaUserToken,
  OAUTH_PROVIDERS,
  OAuthError,
  type OAuthProvider,
  oauthErrorOf,
  pkceChallenge,
  pkceVerifier,
  platformErrorOf,
  platformJson,
  randomState,
  refreshGrant,
  revokedCode,
  SOCIAL_PROVIDER,
  scopesFor,
  tenantOf,
  tokenEndpoint,
  tokenPost,
  whoAmI,
} from "../src/oauth/index.js";
import { driveOAuth } from "../src/sites/drive.js";
import { gmailOAuth } from "../src/sites/gmail.js";
import { instagramOAuth } from "../src/sites/instagram.js";
import { linkedinOAuth } from "../src/sites/linkedin.js";
import { metaOAuth } from "../src/sites/meta.js";
import { pkcePair } from "../src/sites/oauth.js";
import { outlookOAuth } from "../src/sites/outlook.js";
import { threadsOAuth } from "../src/sites/threads.js";
import { tiktokOAuth } from "../src/sites/tiktok.js";
import { xOAuth } from "../src/sites/x.js";
import { youtubeOAuth } from "../src/sites/youtube.js";

const APP = { id: "app-id", secret: "app-secret" };
const SECRET = "tok-SECRET-1234";
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

type Asked = { url: string; init?: RequestInit | undefined };
type Route = (url: string, init?: RequestInit) => Response | undefined;
/** A fake platform: `route` answers by URL; every request is kept. */
function fakeFetch(route: Route) {
  const asked: Asked[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    asked.push({ url, init });
    return route(url, init) ?? new Response("{}", { status: 404 });
  };
  return { fetch, asked };
}
/** One token endpoint: answers `body` with `status`, keeping what it was asked. */
function endpoint(status: number, body: object) {
  return fakeFetch(() => Response.json(body, { status }));
}
const formOf = (a: Asked | undefined) => new URLSearchParams(String(a?.init?.body ?? ""));
const headersOf = (a: Asked | undefined) => (a?.init?.headers ?? {}) as Record<string, string>;
const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

describe("core", () => {
  it("state and PKCE: random, url-safe, and the S256 challenge", () => {
    expect(randomState()).toMatch(/^[\w-]+$/);
    expect(randomState()).not.toBe(randomState());
    expect(pkceVerifier()).toMatch(/^[\w-]{43,128}$/);
    // RFC 7636 appendix B.
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("autobrowse's pkcePair is the piece's pair", () => {
    const p = pkcePair();
    expect(p.challenge).toBe(pkceChallenge(p.verifier));
  });

  describe("tokenPost", () => {
    it("sends keys as basic auth or in the body, as the app asks", async () => {
      const f = endpoint(200, { access_token: "a" });
      await tokenPost(f.fetch, "https://t.test", { grant_type: "x" }, { ...APP, as: "basic" });
      await tokenPost(f.fetch, "https://t.test", { grant_type: "x" }, { ...APP, as: "body" });
      const [b, body] = f.asked;
      expect(b?.init?.method).toBe("POST");
      expect(headersOf(b).authorization).toBe(basic("app-id", "app-secret"));
      expect(String(b?.init?.body)).not.toContain("app-secret");
      expect(formOf(body).get("client_id")).toBe("app-id");
      expect(formOf(body).get("client_secret")).toBe("app-secret");
      expect(headersOf(body).authorization).toBeUndefined();
    });

    it("names the provider's code, first line only, and whether the grant is gone", async () => {
      const ms = endpoint(400, {
        error: "invalid_grant",
        error_description: "AADSTS70000: expired\nTrace ID: 1",
      });
      const err = await tokenPost(ms.fetch, "https://t.test", {}).catch((e) => e);
      expect(err).toBeInstanceOf(OAuthError);
      expect(err).toMatchObject({ code: "invalid_grant", revoked: true });
      expect(err.message).toBe("invalid_grant: AADSTS70000: expired");
      // HubSpot says {status, message}.
      const hs = endpoint(400, { status: "BAD_REFRESH_TOKEN", message: "missing or unknown" });
      await expect(tokenPost(hs.fetch, "https://t.test", {})).rejects.toMatchObject({
        code: "BAD_REFRESH_TOKEN",
        revoked: true,
        message: "BAD_REFRESH_TOKEN: missing or unknown",
      });
      const down = endpoint(503, {});
      await expect(tokenPost(down.fetch, "https://t.test", {})).rejects.toMatchObject({
        code: "http_503",
        revoked: false,
        message: "http_503",
      });
    });

    it("a refusal never carries the body", async () => {
      const e = endpoint(400, { error: "invalid_grant", access_token: SECRET });
      const err = await tokenPost(e.fetch, "https://t.test", {}).catch((x) => x);
      expect(String(err.message)).not.toContain(SECRET);
    });

    it("revoked codes", () => {
      for (const c of ["invalid_grant", "invalid_token", "BAD_REFRESH_TOKEN"])
        expect(revokedCode(c)).toBe(true);
      expect(revokedCode("access_denied")).toBe(false);
      expect(oauthErrorOf(400, { error: "invalid_grant" }).revoked).toBe(true);
    });
  });

  it("reads a JWT's claims, and nothing from junk", () => {
    const j = `x.${Buffer.from('{"email":"a@b.test"}').toString("base64url")}.y`;
    expect(claimsOf(j)).toEqual({ email: "a@b.test" });
    expect(claimsOf("x")).toEqual({});
    expect(claimsOf(undefined)).toEqual({});
    expect(claimsOf("a.!!!.b")).toEqual({});
  });
});

describe("providers", () => {
  it("one row per provider, https everywhere", () => {
    expect(Object.keys(OAUTH_PROVIDERS).sort()).toEqual(
      ["google", "instagram", "linkedin", "meta", "microsoft", "threads", "tiktok", "x"].sort(),
    );
    for (const p of Object.values(OAUTH_PROVIDERS)) {
      expect(p.authorize).toMatch(/^https:\/\//);
      expect(p.token).toMatch(/^https:\/\//);
    }
  });

  it("every site spec in autobrowse reads its URLs from the table", () => {
    const same: [{ authorizeUrl: string; tokenUrl: string }, OAuthProvider][] = [
      [gmailOAuth, "google"],
      [driveOAuth, "google"],
      [youtubeOAuth, "google"],
      [linkedinOAuth, "linkedin"],
      [xOAuth, "x"],
      [tiktokOAuth, "tiktok"],
      [metaOAuth, "meta"],
      [instagramOAuth, "instagram"],
      [threadsOAuth, "threads"],
    ];
    for (const [spec, p] of same) {
      expect(spec.authorizeUrl).toBe(OAUTH_PROVIDERS[p].authorize);
      expect(spec.tokenUrl).toBe(OAUTH_PROVIDERS[p].token);
    }
    expect(outlookOAuth.authorizeUrl).toBe(authorizeEndpoint("microsoft", "common"));
    expect(outlookOAuth.tokenUrl).toBe(tokenEndpoint("microsoft", "common"));
    // The long-lived Meta exchange is the same endpoint as the code's.
    expect(metaOAuth.longLived?.url).toBe(OAUTH_PROVIDERS.meta.token);
    // What a site spec says about the client matches the table.
    expect(OAUTH_PROVIDERS.x.clientAuth).toBe("basic");
    expect(xOAuth.tokenAuth).toBe("basic");
  });

  it("Microsoft takes a tenant: default any work account, bad ones refused", () => {
    expect(authorizeEndpoint("microsoft")).toBe(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
    );
    expect(tokenEndpoint("microsoft", "acme.example")).toBe(
      "https://login.microsoftonline.com/acme.example/oauth2/v2.0/token",
    );
    expect(tokenEndpoint("google", "ignored")).toBe("https://oauth2.googleapis.com/token");
    expect(tenantOf(" common ")).toBe("common");
    expect(() => tenantOf("evil.com/x?y")).toThrow("tenant: a domain or a tenant id");
  });

  describe("authorizeUrl", () => {
    const at = { redirect: "https://app.test/cb", state: "st", scopes: ["a", "b"] };

    it("X asks with PKCE and space-separated scopes", () => {
      const u = new URL(authorizeUrl("x", "app-id", { ...at, verifier: "v".repeat(50) }));
      expect(u.origin + u.pathname).toBe(OAUTH_PROVIDERS.x.authorize);
      expect(Object.fromEntries(u.searchParams)).toEqual({
        redirect_uri: "https://app.test/cb",
        state: "st",
        response_type: "code",
        client_id: "app-id",
        scope: "a b",
        code_challenge: pkceChallenge("v".repeat(50)),
        code_challenge_method: "S256",
      });
    });

    it("TikTok names its client_key and joins scopes with commas", () => {
      const q = new URL(authorizeUrl("tiktok", "app-id", at)).searchParams;
      expect(q.get("client_key")).toBe("app-id");
      expect(q.get("client_id")).toBeNull();
      expect(q.get("scope")).toBe("a,b");
    });

    it("Google asks offline and consent, and a caller's params win", () => {
      const q = new URL(authorizeUrl("google", "app-id", { ...at, verifier: "v" })).searchParams;
      expect(q.get("access_type")).toBe("offline");
      expect(q.get("prompt")).toBe("consent");
      expect(q.get("include_granted_scopes")).toBe("false");
      expect(q.get("code_challenge")).toBe(pkceChallenge("v"));
      const own = new URL(
        authorizeUrl("google", "app-id", { ...at, params: { include_granted_scopes: "true" } }),
      ).searchParams;
      expect(own.get("include_granted_scopes")).toBe("true");
    });

    it("Meta joins with commas and takes no PKCE even with a verifier", () => {
      const q = new URL(authorizeUrl("meta", "app-id", { ...at, verifier: "v" })).searchParams;
      expect(q.get("scope")).toBe("a,b");
      expect(q.get("code_challenge")).toBeNull();
    });

    it("no scope key when there are no scopes", () => {
      const q = new URL(authorizeUrl("linkedin", "app-id", { ...at, scopes: [] })).searchParams;
      expect(q.has("scope")).toBe(false);
    });
  });
});

describe("exchangeCode and refreshGrant: the wire", () => {
  const o = { code: "c", redirect: "https://app.test/cb" };
  const tokens = { access_token: "at", refresh_token: "rt", expires_in: 3600 };

  it("X: Basic header, the id and the verifier in the form, no secret", async () => {
    const e = endpoint(200, tokens);
    expect(await exchangeCode(e.fetch, "x", APP, { ...o, verifier: "ver" })).toEqual(tokens);
    const a = e.asked[0];
    expect(a?.url).toBe("https://api.x.com/2/oauth2/token");
    expect(a?.init?.method).toBe("POST");
    expect(headersOf(a)).toEqual({
      "content-type": "application/x-www-form-urlencoded",
      authorization: basic("app-id", "app-secret"),
    });
    expect(Object.fromEntries(formOf(a))).toEqual({
      grant_type: "authorization_code",
      code: "c",
      redirect_uri: "https://app.test/cb",
      code_verifier: "ver",
      client_id: "app-id",
    });
  });

  it("TikTok: client_key and client_secret in the form, never the verifier", async () => {
    const e = endpoint(200, tokens);
    await exchangeCode(e.fetch, "tiktok", APP, { ...o, verifier: "ver" });
    const a = e.asked[0];
    expect(a?.url).toBe("https://open.tiktokapis.com/v2/oauth/token/");
    expect(headersOf(a)).toEqual({ "content-type": "application/x-www-form-urlencoded" });
    expect(Object.fromEntries(formOf(a))).toEqual({
      grant_type: "authorization_code",
      code: "c",
      redirect_uri: "https://app.test/cb",
      client_key: "app-id",
      client_secret: "app-secret",
    });
  });

  it("Google: client_id and secret in the form; the verifier only when given", async () => {
    const e = endpoint(200, tokens);
    await exchangeCode(e.fetch, "google", APP, { ...o, verifier: "ver" });
    await exchangeCode(e.fetch, "google", APP, { ...o, verifier: null });
    const [withV, without] = e.asked;
    expect(withV?.url).toBe("https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(formOf(withV))).toEqual({
      grant_type: "authorization_code",
      code: "c",
      redirect_uri: "https://app.test/cb",
      code_verifier: "ver",
      client_id: "app-id",
      client_secret: "app-secret",
    });
    expect(formOf(without).has("code_verifier")).toBe(false);
  });

  it("LinkedIn: access-only exchange with the keys in the form, no verifier", async () => {
    const e = endpoint(200, { access_token: "li", expires_in: 5_184_000 });
    await exchangeCode(e.fetch, "linkedin", APP, { ...o, verifier: "ver" });
    const a = e.asked[0];
    expect(a?.url).toBe("https://www.linkedin.com/oauth/v2/accessToken");
    expect(Object.fromEntries(formOf(a))).toEqual({
      grant_type: "authorization_code",
      code: "c",
      redirect_uri: "https://app.test/cb",
      client_id: "app-id",
      client_secret: "app-secret",
    });
  });

  it("Instagram Login and Threads: their own token URLs", async () => {
    const e = endpoint(200, tokens);
    await exchangeCode(e.fetch, "instagram", APP, o);
    await exchangeCode(e.fetch, "threads", APP, o);
    expect(e.asked.map((a) => a.url)).toEqual([
      "https://api.instagram.com/oauth/access_token",
      "https://graph.threads.net/oauth/access_token",
    ]);
  });

  it("Microsoft: the tenant is in the URL", async () => {
    const e = endpoint(200, tokens);
    await exchangeCode(e.fetch, "microsoft", APP, { ...o, verifier: "v", tenant: "acme.example" });
    expect(e.asked[0]?.url).toBe(
      "https://login.microsoftonline.com/acme.example/oauth2/v2.0/token",
    );
  });

  it("refresh: the provider's client style over grant_type and refresh_token", async () => {
    const e = endpoint(200, tokens);
    await refreshGrant(e.fetch, "x", APP, "r1");
    await refreshGrant(e.fetch, "tiktok", APP, "r1");
    await refreshGrant(e.fetch, "google", APP, "r1");
    const [x, tt, g] = e.asked;
    expect(Object.fromEntries(formOf(x))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "r1",
      client_id: "app-id",
    });
    expect(headersOf(x).authorization).toBe(basic("app-id", "app-secret"));
    expect(Object.fromEntries(formOf(tt))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "r1",
      client_key: "app-id",
      client_secret: "app-secret",
    });
    expect(Object.fromEntries(formOf(g))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "r1",
      client_id: "app-id",
      client_secret: "app-secret",
    });
    expect(headersOf(g).authorization).toBeUndefined();
  });

  it("a refusal carries the provider's code and first line, never the body", async () => {
    const e = endpoint(400, {
      error: "invalid_grant",
      error_description: "bad code",
      access_token: SECRET,
    });
    const err = await exchangeCode(e.fetch, "google", APP, { ...o, verifier: "v" }).catch(
      (x: unknown) => x,
    );
    expect(err).toBeInstanceOf(OAuthError);
    expect(err).toMatchObject({ code: "invalid_grant", revoked: true });
    expect((err as Error).message).toBe("invalid_grant: bad code");
    expect((err as Error).message).not.toContain(SECRET);
  });
});

describe("error mapping: the social parser", () => {
  it("Meta's code 190 is a revoked token", async () => {
    const { fetch } = fakeFetch(() =>
      Response.json({ error: { code: 190, message: "Session expired" } }, { status: 400 }),
    );
    const err = await whoAmI(fetch, "facebook", "t", { pageId: "p1" }).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect(err).toMatchObject({ code: "invalid_token", revoked: true });
    expect(err.message).toBe("invalid_token: Session expired");
  });

  it("another Meta code is meta_<code> and not revoked", () => {
    const e = platformErrorOf(400, { error: { code: 10, message: "Permission denied\nmore" } });
    expect(e).toMatchObject({ code: "meta_10", revoked: false });
    expect(e.message).toBe("meta_10: Permission denied");
    expect(platformErrorOf(500, { error: { message: "oops" } }).code).toBe("meta_500");
  });

  it("an HTTP 401 is revoked whatever it says", () => {
    expect(platformErrorOf(401, {})).toMatchObject({ code: "http_401", revoked: true });
    expect(platformErrorOf(401, { error: "weird" })).toMatchObject({
      code: "weird",
      revoked: true,
    });
    expect(platformErrorOf(503, {})).toMatchObject({ code: "http_503", revoked: false });
  });

  it("a message is cut at 160 characters", () => {
    const e = platformErrorOf(400, { error: "bad", error_description: "y".repeat(400) });
    expect(e.message).toBe(`bad: ${"y".repeat(160)}`);
  });

  it("TikTok's {error: {code: ok}} is success; another code is a refusal", async () => {
    const ok = fakeFetch(() => Response.json({ data: { x: 1 }, error: { code: "ok" } }));
    expect(await platformJson(ok.fetch, "https://t.test", { method: "GET" })).toMatchObject({
      data: { x: 1 },
    });
    const bad = fakeFetch(() =>
      Response.json({ error: { code: "access_token_invalid", message: "bad" } }),
    );
    await expect(platformJson(bad.fetch, "https://t.test", {})).rejects.toMatchObject({
      code: "meta_access_token_invalid",
    });
    const junk = fakeFetch(() => new Response("<html>", { status: 502 }));
    await expect(platformJson(junk.fetch, "https://t.test", {})).rejects.toMatchObject({
      code: "http_502",
    });
  });
});

describe("Meta: user token and Pages", () => {
  it("the code for a short token, then a long one; both GETs with the app's keys", async () => {
    const { fetch, asked } = fakeFetch((url) =>
      url.includes("fb_exchange_token=")
        ? Response.json({ access_token: "long-user", expires_in: 5_184_000 })
        : Response.json({ access_token: "short" }),
    );
    const long = await metaUserToken(fetch, APP, { code: "c", redirect: "https://app.test/cb" });
    expect(long).toEqual({ access_token: "long-user", expires_in: 5_184_000 });
    const [s, l] = asked;
    expect(s?.init).toEqual({ method: "GET" });
    const su = new URL(s?.url ?? "");
    expect(su.origin + su.pathname).toBe("https://graph.facebook.com/v23.0/oauth/access_token");
    expect(Object.fromEntries(su.searchParams)).toEqual({
      client_id: "app-id",
      client_secret: "app-secret",
      redirect_uri: "https://app.test/cb",
      code: "c",
    });
    expect(l?.init).toEqual({ method: "GET" });
    expect(Object.fromEntries(new URL(l?.url ?? "").searchParams)).toEqual({
      grant_type: "fb_exchange_token",
      client_id: "app-id",
      client_secret: "app-secret",
      fb_exchange_token: "short",
    });
  });

  it("lists what was granted and the Pages, with the same fields", async () => {
    const { fetch, asked } = fakeFetch((url) =>
      url.includes("/me/permissions")
        ? Response.json({
            data: [
              { permission: "pages_manage_posts", status: "granted" },
              { permission: "business_management", status: "declined" },
            ],
          })
        : url.includes("/me/accounts")
          ? Response.json({ data: [{ id: "p1", name: "Plain Page", access_token: SECRET }] })
          : undefined,
    );
    const got = await metaPages(fetch, "user-tok");
    expect(got.granted).toEqual(["pages_manage_posts"]);
    expect(got.pages).toEqual([{ id: "p1", name: "Plain Page", access_token: SECRET }]);
    expect(asked[0]?.url).toBe("https://graph.facebook.com/v23.0/me/permissions");
    expect(asked[1]?.url).toBe(
      `https://graph.facebook.com/v23.0/me/accounts?fields=${encodeURIComponent("id,name,access_token,instagram_business_account{id,username}")}`,
    );
    expect(headersOf(asked[1])).toEqual({ authorization: "Bearer user-tok" });
  });

  it("a refusal reads as the social parser: 190 is revoked", async () => {
    const { fetch } = fakeFetch(() =>
      Response.json({ error: { code: 190, message: "expired" } }, { status: 400 }),
    );
    await expect(metaPages(fetch, "t")).rejects.toMatchObject({ revoked: true });
  });
});

describe("whoAmI", () => {
  it("every platform maps to one provider in the table", () => {
    for (const p of Object.values(SOCIAL_PROVIDER)) expect(OAUTH_PROVIDERS[p]).toBeDefined();
    expect(SOCIAL_PROVIDER.facebook).toBe("meta");
    expect(SOCIAL_PROVIDER.linkedin_page).toBe("linkedin");
  });

  it("a Page and an Instagram account read themselves by id", async () => {
    const { fetch, asked } = fakeFetch((url) =>
      url.endsWith("/p1?fields=id,name")
        ? Response.json({ id: "p1", name: "Plain Page" })
        : url.endsWith("/ig9?fields=id,username")
          ? Response.json({ id: "ig9", username: "shop" })
          : undefined,
    );
    expect(await whoAmI(fetch, "facebook", "tok", { pageId: "p1" })).toEqual({
      externalId: "p1",
      name: "Plain Page",
      handle: null,
    });
    expect(await whoAmI(fetch, "instagram", "tok", { igUserId: "ig9" })).toEqual({
      externalId: "ig9",
      name: "shop",
      handle: "shop",
    });
    expect(headersOf(asked[0]).authorization).toBe("Bearer tok");
  });

  it("TikTok asks only for fields the granted scopes cover, and keeps an https avatar", async () => {
    const answer = (avatar_url: string) =>
      fakeFetch(() =>
        Response.json({
          data: { user: { open_id: "o1", display_name: "Acme", avatar_url } },
          error: { code: "ok" },
        }),
      );
    const ok = answer("https://p16.tiktokcdn.example/a.jpeg");
    const who = await whoAmI(ok.fetch, "tiktok", "tok", {});
    expect(ok.asked[0]?.url).toBe(
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url",
    );
    expect(who).toEqual({
      externalId: "o1",
      name: "Acme",
      handle: null,
      extra: { avatarUrl: "https://p16.tiktokcdn.example/a.jpeg" },
    });
    const plain = await whoAmI(answer("http://p16.example/a.jpeg").fetch, "tiktok", "tok", {});
    expect(plain.extra).toBeUndefined();
  });

  it("X reads /2/users/me; LinkedIn reads userinfo", async () => {
    const { fetch } = fakeFetch((url) =>
      url.endsWith("/2/users/me")
        ? Response.json({ data: { id: "u1", name: "Acme", username: "acme" } })
        : url.endsWith("/v2/userinfo")
          ? Response.json({ sub: "m1", name: "Amy" })
          : undefined,
    );
    expect(await whoAmI(fetch, "x", "t", {})).toEqual({
      externalId: "u1",
      name: "Acme",
      handle: "acme",
    });
    expect(await whoAmI(fetch, "linkedin", "t", {})).toEqual({
      externalId: "m1",
      name: "Amy",
      handle: null,
    });
  });

  it("YouTube's @handle is kept bare; no channel says so", async () => {
    const yes = fakeFetch((url) =>
      url === "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true"
        ? Response.json({ items: [{ id: "UC1", snippet: { title: "Acme", customUrl: "@acme" } }] })
        : undefined,
    );
    expect(await whoAmI(yes.fetch, "youtube", "t", {})).toEqual({
      externalId: "UC1",
      name: "Acme",
      handle: "acme",
    });
    const none = fakeFetch(() => Response.json({ items: [] }));
    await expect(whoAmI(none.fetch, "youtube", "t", {})).rejects.toMatchObject({
      code: "no_channel",
      revoked: false,
    });
  });

  it("a LinkedIn company page: the first page the member admins, with LinkedIn's headers", async () => {
    const { fetch, asked } = fakeFetch((url) =>
      url.includes("/rest/organizationAcls")
        ? Response.json({ elements: [{ organization: "urn:li:organization:5" }] })
        : url.endsWith("/rest/organizations/5")
          ? Response.json({ localizedName: "Acme Co", vanityName: "acme" })
          : undefined,
    );
    expect(await whoAmI(fetch, "linkedin_page", "t", {})).toEqual({
      externalId: "5",
      name: "Acme Co",
      handle: "acme",
      extra: { orgUrn: "urn:li:organization:5" },
    });
    expect(asked[0]?.url).toBe(
      "https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED",
    );
    expect(headersOf(asked[1])).toEqual({
      authorization: "Bearer t",
      "LinkedIn-Version": LINKEDIN_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
    });
    const again = fakeFetch((url) =>
      url.endsWith("/rest/organizations/5")
        ? Response.json({ localizedName: "Acme Co" })
        : undefined,
    );
    await whoAmI(again.fetch, "linkedin_page", "t", { orgUrn: "urn:li:organization:5" });
    expect(again.asked).toHaveLength(1);
  });

  it("a LinkedIn member who admins no page is told so", async () => {
    const { fetch } = fakeFetch(() => Response.json({ elements: [] }));
    await expect(whoAmI(fetch, "linkedin_page", "t", {})).rejects.toMatchObject({
      code: "no_page",
      message: "You aren't an admin of a LinkedIn company page. Sign in as one.",
    });
  });

  it("a Business Profile lands on its account's first location; a known one reads itself", async () => {
    const { fetch } = fakeFetch((url) =>
      url.endsWith("/v1/accounts")
        ? Response.json({ accounts: [{ name: "accounts/1", accountName: "Acme" }] })
        : url.includes("/accounts/1/locations?")
          ? Response.json({ locations: [{ name: "locations/2", title: "Acme Downtown" }] })
          : url.includes("/locations/2?")
            ? Response.json({ title: "Acme Downtown" })
            : undefined,
    );
    expect(await whoAmI(fetch, "google_business", "t", {})).toEqual({
      externalId: "accounts/1/locations/2",
      name: "Acme Downtown",
      handle: null,
      extra: { location: "accounts/1/locations/2" },
    });
    const known = { location: "accounts/1/locations/2" };
    expect(await whoAmI(fetch, "google_business", "t", known)).toEqual({
      externalId: "accounts/1/locations/2",
      name: "Acme Downtown",
      handle: null,
      extra: known,
    });
    const noAccount = fakeFetch(() => Response.json({ accounts: [] }));
    await expect(whoAmI(noAccount.fetch, "google_business", "t", {})).rejects.toMatchObject({
      code: "no_profile",
    });
  });
});

describe("mail: scopes and URLs", () => {
  it("read always comes with send; identity for the address", () => {
    expect(scopesFor("google", "send")).toEqual(expect.arrayContaining([GMAIL_SEND]));
    expect(scopesFor("google", "send")).not.toContain(GMAIL_READ);
    expect(scopesFor("google", "read")).toEqual(
      expect.arrayContaining([GMAIL_READ, GMAIL_SEND, "openid", "email"]),
    );
    expect(scopesFor("microsoft", "read")).toEqual(
      expect.arrayContaining([GRAPH_READ, GRAPH_SEND, "openid", "email", "offline_access"]),
    );
  });

  it("what a grant lets the app do", () => {
    expect(accessOf("google", [GMAIL_SEND])).toBe("send");
    expect(accessOf("google", [GMAIL_READ, GMAIL_SEND])).toBe("read");
    expect(accessOf("google", [GMAIL_READ])).toBeNull();
    expect(accessOf("microsoft", graphScopes("Mail.Read Mail.Send openid"))).toBe("read");
    expect(accessOf("microsoft", graphScopes("mail.send"))).toBe("send");
  });

  it("Google: offline, consent, PKCE, and hd only for Workspace", () => {
    const o = {
      redirect: "https://app.test/oauth/mail/google",
      state: "st",
      verifier: "v".repeat(48),
      want: "read" as const,
      address: "ann@acme.example",
    };
    const u = new URL(mailConnectUrl("google", APP, o));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "app-id",
      redirect_uri: "https://app.test/oauth/mail/google",
      response_type: "code",
      scope: scopesFor("google", "read").join(" "),
      state: "st",
      code_challenge: pkceChallenge("v".repeat(48)),
      code_challenge_method: "S256",
      login_hint: "ann@acme.example",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      hd: "acme.example",
    });
    expect(u.toString()).not.toContain("app-secret");
    const personal = new URL(
      mailConnectUrl("google", APP, { ...o, want: "send", address: "bo@gmail.com" }),
    );
    expect(personal.searchParams.get("hd")).toBeNull();
    expect(CONSUMER_GOOGLE.has("gmail.com")).toBe(true);
  });

  it("Microsoft: the tenant in the path, select_account, and a bad tenant refused", () => {
    const o = {
      redirect: "r",
      state: "s",
      verifier: "v",
      want: "send" as const,
      address: "a@b.test",
    };
    const u = new URL(mailConnectUrl("microsoft", APP, o));
    expect(u.origin + u.pathname).toBe(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
    );
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_mode: "query",
      prompt: "select_account",
      login_hint: "a@b.test",
      code_challenge_method: "S256",
    });
    expect(u.searchParams.has("access_type")).toBe(false);
    expect(mailConnectUrl("microsoft", APP, { ...o, tenant: "acme.example" })).toContain(
      "/acme.example/oauth2/",
    );
    expect(() => mailConnectUrl("microsoft", APP, { ...o, tenant: "evil.com/x?y" })).toThrow();
  });

  it("admin consent names the scopes on the v2 endpoint", () => {
    const u = new URL(mailConsentUrl(APP, { tenant: "acme.example", redirect: "r", state: "s" }));
    expect(u.pathname).toBe("/acme.example/v2.0/adminconsent");
    const scope = u.searchParams.get("scope") ?? "";
    for (const s of [GRAPH_READ, GRAPH_SEND, "offline_access"]) expect(scope).toContain(s);
    expect(() => mailConsentUrl(APP, { tenant: "a/b", redirect: "r", state: "s" })).toThrow();
  });
});

describe("mail: tokens", () => {
  it("an exchange keeps the refresh token, the scopes and who signed in", async () => {
    const e = endpoint(200, {
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3599,
      scope: `${GMAIL_SEND} openid`,
      id_token: jwt({ email: "Ann@Acme.example", hd: "acme.example" }),
    });
    const t = await mailExchange(e.fetch, "google", APP, {
      code: "c",
      redirect: "r",
      verifier: "v",
    });
    expect(t).toMatchObject({
      access: "at",
      refresh: "rt",
      expiresIn: 3599,
      scopes: [GMAIL_SEND, "openid"],
      address: "ann@acme.example",
    });
    const a = e.asked[0];
    expect(a?.url).toBe("https://oauth2.googleapis.com/token");
    expect(a?.init?.method).toBe("POST");
    expect(Object.fromEntries(formOf(a))).toEqual({
      grant_type: "authorization_code",
      code: "c",
      redirect_uri: "r",
      client_id: "app-id",
      client_secret: "app-secret",
      code_verifier: "v",
    });
  });

  it("Microsoft's refresh goes to the tenant's endpoint and keeps the rotated token", async () => {
    const e = endpoint(200, {
      access_token: "at",
      refresh_token: "rt2",
      scope: "Mail.Read Mail.Send openid",
      id_token: jwt({ preferred_username: "ann@acme.example", tid: "tid-1" }),
    });
    const t = await mailRefresh(e.fetch, "microsoft", APP, { refresh: "rt", tenant: "tid-1" });
    expect(t.refresh).toBe("rt2");
    expect(t.expiresIn).toBe(3600);
    expect(e.asked[0]?.url).toBe("https://login.microsoftonline.com/tid-1/oauth2/v2.0/token");
    expect(Object.fromEntries(formOf(e.asked[0]))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "rt",
      client_id: "app-id",
      client_secret: "app-secret",
    });
  });

  it("a revoked grant says so and carries no token", async () => {
    const e = endpoint(400, { error: "invalid_grant", error_description: "Token revoked\nmore" });
    const err = await mailRefresh(e.fetch, "google", APP, { refresh: "secret-rt" }).catch((x) => x);
    expect(err).toBeInstanceOf(OAuthError);
    expect(err.revoked).toBe(true);
    expect(err.message).toBe("invalid_grant: Token revoked");
    expect(err.message).not.toContain("secret-rt");
  });

  it("Microsoft's AADSTS700016 says the app is not in the tenant; a token says it is", async () => {
    expect((await appInTenant(endpoint(200, { access_token: "x" }).fetch, APP, "t")).ok).toBe(true);
    const no = endpoint(400, {
      error: "unauthorized_client",
      error_description: "AADSTS700016: Application not found in the directory",
    });
    expect(await appInTenant(no.fetch, APP, "t")).toEqual({
      ok: false,
      why: "Wren's app isn't in the tenant: the admin hasn't consented",
    });
    expect(formOf(no.asked[0]).get("scope")).toBe("https://graph.microsoft.com/.default");
    expect(formOf(no.asked[0]).get("grant_type")).toBe("client_credentials");
  });
});

describe("connected apps", () => {
  const SPEC: Record<string, AppSpec> = {
    hubspot: {
      label: "HubSpot",
      authorize: "https://app.hubspot.example/oauth/authorize",
      token: "https://api.hubspot.example/oauth/v1/token",
      scopes: ["oauth", "crm.objects.contacts.read"],
      auth: "body",
    },
    quickbooks: {
      label: "QuickBooks",
      authorize: "https://qb.example/connect/oauth2",
      token: "https://qb.example/oauth2/v1/tokens/bearer",
      scopes: ["com.example.accounting"],
      auth: "basic",
    },
    jobber: {
      label: "Jobber",
      authorize: "https://jobber.example/oauth/authorize",
      token: "https://jobber.example/oauth/token",
      scopes: [],
      auth: "body",
    },
  };
  const spec = (k: string) => SPEC[k] as AppSpec;
  const to = { code: "c", redirect: "https://p.test/cb" };

  it("asks for the spec's scopes, and none when it has none", () => {
    const hs = new URL(
      appConnectUrl(spec("hubspot"), APP, { redirect: "https://p.test/cb", state: "s1" }),
    );
    expect(Object.fromEntries(hs.searchParams)).toEqual({
      client_id: "app-id",
      redirect_uri: "https://p.test/cb",
      state: "s1",
      response_type: "code",
      scope: "oauth crm.objects.contacts.read",
    });
    const jb = new URL(appConnectUrl(spec("jobber"), APP, { redirect: "r", state: "s2" }));
    expect(jb.searchParams.has("scope")).toBe(false);
  });

  it("sends QuickBooks the app's keys as basic auth, the others in the body", async () => {
    const f = endpoint(200, { access_token: "a1", refresh_token: "r2", expires_in: 3600 });
    await appExchange(f.fetch, spec("quickbooks"), APP, to);
    await appExchange(f.fetch, spec("hubspot"), APP, to);
    const [qb, hs] = f.asked;
    expect(headersOf(qb).authorization).toBe(basic("app-id", "app-secret"));
    expect(String(qb?.init?.body)).not.toContain("app-secret");
    expect(Object.fromEntries(formOf(hs))).toEqual({
      grant_type: "authorization_code",
      code: "c",
      redirect_uri: "https://p.test/cb",
      client_id: "app-id",
      client_secret: "app-secret",
    });
  });

  it("answers access, refresh and seconds; seconds default to 3600", async () => {
    const f = endpoint(200, { access_token: "a1", refresh_token: "r2", expires_in: 1800 });
    expect(await appExchange(f.fetch, spec("hubspot"), APP, to)).toEqual({
      access: "a1",
      refresh: "r2",
      expiresIn: 1800,
    });
    const g = endpoint(200, { access_token: "a1", refresh_token: "r2", expires_in: "soon" });
    expect((await appExchange(g.fetch, spec("hubspot"), APP, to)).expiresIn).toBe(3600);
  });

  it("keeps the old refresh token when none comes back", async () => {
    const ok = endpoint(200, { access_token: "a2", expires_in: 60 });
    expect(await appRefresh(ok.fetch, spec("hubspot"), APP, "r1")).toEqual({
      access: "a2",
      refresh: "r1",
      expiresIn: 60,
    });
    expect(Object.fromEntries(formOf(ok.asked[0]))).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "r1",
    });
  });

  it("says a revoked grant, HubSpot's BAD_REFRESH_TOKEN included", async () => {
    const no = endpoint(400, { error: "invalid_grant" });
    await expect(appRefresh(no.fetch, spec("jobber"), APP, "r1")).rejects.toMatchObject({
      revoked: true,
    });
    const hs = endpoint(400, { status: "BAD_REFRESH_TOKEN", message: "missing or unknown" });
    await expect(appRefresh(hs.fetch, spec("hubspot"), APP, "r1")).rejects.toMatchObject({
      code: "BAD_REFRESH_TOKEN",
      revoked: true,
    });
  });

  it("no access token and no refresh token are named with the app's label", async () => {
    const none = endpoint(200, { refresh_token: "r" });
    await expect(appExchange(none.fetch, spec("quickbooks"), APP, to)).rejects.toMatchObject({
      code: "no_access",
      message: "QuickBooks gave no access token",
      revoked: false,
    });
    const noRefresh = endpoint(200, { access_token: "a" });
    await expect(appExchange(noRefresh.fetch, spec("jobber"), APP, to)).rejects.toMatchObject({
      code: "no_refresh",
      message: "Jobber gave no refresh token",
    });
  });
});
