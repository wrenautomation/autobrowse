/**
 * The social platforms' sign-in wire: the code's exchange, a refresh, Meta's user token and Pages,
 * and a who-am-I read per platform. Every call goes through `FetchLike`. Tokens go back to the
 * caller only, never into an error or a log line. The caller keeps what a token answer means:
 * what to store, when it lapses, which Page to pick.
 *
 * Errors here come from `platformJson`/`platformErrorOf`, not from `tokenPost`/`oauthErrorOf`
 * (`./core.ts`): the two parsers stay two. Social callers keep this one; mail and connected apps
 * keep the other.
 */
import type { FetchLike } from "../clients/http.js";
import { type OAuthApp, OAuthError, revokedCode } from "./core.js";
import { OAUTH_PROVIDERS, type OAuthProvider, tokenEndpoint } from "./providers.js";

export const GRAPH = "https://graph.facebook.com/v23.0";
export const LINKEDIN_API = "https://api.linkedin.com";
export const GOOGLE_API = "https://www.googleapis.com";
export const GBP_ACCOUNTS = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";
/** Business Profile locations (v1) and their posts and reviews (v4). */
export const GBP_INFO = "https://mybusinessbusinessinformation.googleapis.com/v1";
export const GBP_API = "https://mybusiness.googleapis.com";
/**
 * LinkedIn's versioned REST API: the month it speaks. A version lives a year, then every call
 * answers 426 (202508 lapsed by 2026-10-13); 202609 runs to about 2027-09.
 */
export const LINKEDIN_VERSION = "202609";
export const X_API = "https://api.x.com";
export const TIKTOK_API = "https://open.tiktokapis.com";

/** The social accounts a client connects. */
export type SocialPlatform =
  | "facebook"
  | "instagram"
  | "linkedin"
  | "linkedin_page"
  | "youtube"
  | "x"
  | "tiktok"
  | "google_business";

/** The provider each social platform signs in at. */
export const SOCIAL_PROVIDER: Record<SocialPlatform, OAuthProvider> = {
  facebook: "meta",
  instagram: "meta",
  linkedin: "linkedin",
  linkedin_page: "linkedin",
  youtube: "google",
  x: "x",
  tiktok: "tiktok",
  google_business: "google",
};

/**
 * What a connection carries beside its token: the Page an Instagram account posts through, a
 * LinkedIn company page's URN, a Business Profile's location.
 */
export interface SocialExtra {
  pageId?: string;
  pageName?: string;
  igUserId?: string;
  /** `urn:li:organization:<id>`: the company page it posts as. */
  orgUrn?: string;
  /** `accounts/<a>/locations/<l>`: the Business Profile it posts as and reads reviews of. */
  location?: string;
  /**
   * The account's picture at the platform's CDN (TikTok's `avatar_url`), read on connect and on
   * each hourly check: TikTok's addresses expire, so the check keeps it fresh.
   */
  avatarUrl?: string;
}

export type Json = Record<string, unknown>;

/** The platform's error code and first line, never the body: a success holds a token. */
export function platformErrorOf(status: number, b: Json): OAuthError {
  const e = b.error;
  const meta = e && typeof e === "object" ? (e as Json) : null;
  const code = meta
    ? Number(meta.code) === 190
      ? "invalid_token"
      : `meta_${String(meta.code ?? status)}`
    : typeof e === "string"
      ? e
      : `http_${status}`;
  const said = String(
    (meta?.message as string | undefined) ?? b.error_description ?? b.message ?? "",
  )
    .split(/\r?\n/)[0]
    ?.slice(0, 160);
  return new OAuthError(
    code,
    said ? `${code}: ${said}` : code,
    revokedCode(code) || status === 401,
  );
}

/** One call to a platform: its JSON, or an `OAuthError`. TikTok's `{error: {code: "ok"}}` is success. */
export async function platformJson(
  fetch: FetchLike,
  url: string,
  init: RequestInit,
): Promise<Json> {
  const res = await fetch(url, init);
  const b = (await res.json().catch(() => ({}))) as Json;
  const e = b.error;
  // TikTok answers `{error: {code: "ok"}}` on success.
  const ok = e == null || e === "" || (typeof e === "object" && (e as Json).code === "ok");
  if (!res.ok || !ok) throw platformErrorOf(res.status, b);
  return b;
}

const form = (fields: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  body: new URLSearchParams(fields).toString(),
});
const bearer = (token: string): RequestInit => ({
  method: "GET",
  headers: { authorization: `Bearer ${token}` },
});
/** LinkedIn's REST reads: its version and Rest.li 2.0. */
const linkedinGet = (token: string): RequestInit => ({
  method: "GET",
  headers: {
    authorization: `Bearer ${token}`,
    "LinkedIn-Version": LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  },
});
const basic = (app: OAuthApp) => ({
  authorization: `Basic ${Buffer.from(`${app.id}:${app.secret}`).toString("base64")}`,
});
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
/** A picture's address, https only and of a sane length; anything else is no picture. */
const https = (v: unknown) =>
  typeof v === "string" && v.startsWith("https://") && v.length <= 2000 ? v : null;

/** A token call's request: the provider's client-auth style over the grant's own fields. */
function tokenRequest(provider: OAuthProvider, client: OAuthApp, fields: Record<string, string>) {
  const p = OAUTH_PROVIDERS[provider];
  if (p.clientAuth === "basic")
    return form({ ...fields, [p.clientIdParam]: client.id }, basic(client));
  return form({ ...fields, [p.clientIdParam]: client.id, client_secret: client.secret });
}

/**
 * The code from the callback, for the provider's token JSON. X sends its keys as a Basic header
 * and the id in the form, TikTok as `client_key` and `client_secret`, the rest as `client_id` and
 * `client_secret`. The PKCE verifier goes only where the provider uses PKCE. Meta's exchange is a
 * GET in two steps: use `metaUserToken`.
 */
export async function exchangeCode(
  fetch: FetchLike,
  provider: Exclude<OAuthProvider, "meta">,
  client: OAuthApp,
  o: { code: string; redirect: string; verifier?: string | null; tenant?: string | null },
): Promise<Json> {
  const fields: Record<string, string> = {
    grant_type: "authorization_code",
    code: o.code,
    redirect_uri: o.redirect,
    ...(o.verifier && OAUTH_PROVIDERS[provider].pkce ? { code_verifier: o.verifier } : {}),
  };
  return platformJson(
    fetch,
    tokenEndpoint(provider, o.tenant),
    tokenRequest(provider, client, fields),
  );
}

/** A fresh access token's JSON from a refresh token. X and TikTok rotate: the answer holds the new one. */
export function refreshGrant(
  fetch: FetchLike,
  provider: Exclude<OAuthProvider, "meta">,
  client: OAuthApp,
  refreshToken: string,
  o: { tenant?: string | null } = {},
): Promise<Json> {
  return platformJson(
    fetch,
    tokenEndpoint(provider, o.tenant),
    tokenRequest(provider, client, { grant_type: "refresh_token", refresh_token: refreshToken }),
  );
}

/**
 * Meta: the code for a short user token, and that for a long-lived one (`fb_exchange_token`).
 * Answers the long one's JSON. The caller trades it for a Page's token, which never lapses.
 */
export async function metaUserToken(
  fetch: FetchLike,
  client: OAuthApp,
  o: { code: string; redirect: string },
): Promise<Json> {
  const token = OAUTH_PROVIDERS.meta.token;
  const q = (p: Record<string, string>) => `${token}?${new URLSearchParams(p)}`;
  const short = await platformJson(
    fetch,
    q({
      client_id: client.id,
      client_secret: client.secret,
      redirect_uri: o.redirect,
      code: o.code,
    }),
    { method: "GET" },
  );
  return platformJson(
    fetch,
    q({
      grant_type: "fb_exchange_token",
      client_id: client.id,
      client_secret: client.secret,
      fb_exchange_token: String(short.access_token ?? ""),
    }),
    { method: "GET" },
  );
}

/** What the person granted Meta's user token, and the Pages they manage with their own tokens. */
export async function metaPages(
  fetch: FetchLike,
  userToken: string,
): Promise<{ granted: string[]; pages: Json[] }> {
  const perms = await platformJson(fetch, `${GRAPH}/me/permissions`, bearer(userToken));
  const granted = ((perms.data as Json[] | undefined) ?? [])
    .filter((p) => p.status === "granted")
    .map((p) => String(p.permission));
  const pages = await platformJson(
    fetch,
    `${GRAPH}/me/accounts?fields=${encodeURIComponent("id,name,access_token,instagram_business_account{id,username}")}`,
    bearer(userToken),
  );
  return { granted, pages: (pages.data as Json[] | undefined) ?? [] };
}

/**
 * Who the token is: one free read. A Page, Instagram account, company page or Profile location
 * reads itself by id. Signing in, a company page or a Profile takes the first one the person
 * manages, and says it in `extra`.
 */
export async function whoAmI(
  fetch: FetchLike,
  platform: SocialPlatform,
  access: string,
  extra: SocialExtra,
): Promise<{
  externalId: string;
  name: string | null;
  handle: string | null;
  extra?: SocialExtra;
}> {
  const json = platformJson;
  switch (platform) {
    case "facebook": {
      const b = await json(fetch, `${GRAPH}/${extra.pageId}?fields=id,name`, bearer(access));
      return { externalId: String(b.id), name: str(b.name), handle: null };
    }
    case "instagram": {
      const b = await json(fetch, `${GRAPH}/${extra.igUserId}?fields=id,username`, bearer(access));
      return { externalId: String(b.id), name: str(b.username), handle: str(b.username) };
    }
    case "linkedin": {
      const b = await json(fetch, `${LINKEDIN_API}/v2/userinfo`, bearer(access));
      return { externalId: String(b.sub), name: str(b.name), handle: null };
    }
    case "youtube": {
      const b = await json(
        fetch,
        `${GOOGLE_API}/youtube/v3/channels?part=snippet&mine=true`,
        bearer(access),
      );
      const ch = ((b.items as Json[] | undefined) ?? [])[0];
      if (!ch)
        throw new OAuthError(
          "no_channel",
          "This Google account has no YouTube channel. Sign in with the one that owns it.",
          false,
        );
      const sn = (ch.snippet as Json | undefined) ?? {};
      // customUrl comes as "@handle"; handles are kept bare, the page adds the "@".
      return {
        externalId: String(ch.id),
        name: str(sn.title),
        handle: str(sn.customUrl)?.replace(/^@/, "") ?? null,
      };
    }
    case "x": {
      const b = await json(fetch, `${X_API}/2/users/me`, bearer(access));
      const d = (b.data as Json | undefined) ?? {};
      return { externalId: String(d.id), name: str(d.name), handle: str(d.username) };
    }
    case "tiktok": {
      const b = await json(
        fetch,
        // `username` needs user.info.profile, a scope the app may not hold: asking 401s the connect.
        // The avatar is user.info.basic's, kept so a page can show who is connected.
        `${TIKTOK_API}/v2/user/info/?fields=open_id,display_name,avatar_url`,
        bearer(access),
      );
      const u = ((b.data as Json | undefined)?.user as Json | undefined) ?? {};
      const avatarUrl = https(u.avatar_url);
      return {
        externalId: String(u.open_id),
        name: str(u.display_name),
        handle: null,
        ...(avatarUrl ? { extra: { avatarUrl } } : {}),
      };
    }
    case "linkedin_page": {
      let org = extra.orgUrn;
      if (!org) {
        const acl = await json(
          fetch,
          `${LINKEDIN_API}/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED`,
          linkedinGet(access),
        );
        const first = ((acl.elements as Json[] | undefined) ?? [])[0];
        org = str(first?.organization) ?? str(first?.organizationalTarget) ?? undefined;
        if (!org)
          throw new OAuthError(
            "no_page",
            "You aren't an admin of a LinkedIn company page. Sign in as one.",
            false,
          );
      }
      const id = org.split(":").pop() ?? "";
      const b = await json(fetch, `${LINKEDIN_API}/rest/organizations/${id}`, linkedinGet(access));
      return {
        externalId: id,
        name: str(b.localizedName),
        handle: str(b.vanityName),
        extra: { orgUrn: org },
      };
    }
    case "google_business": {
      const fields = "readMask=name,title";
      if (extra.location) {
        const at = extra.location.slice(extra.location.indexOf("locations/"));
        const b = await json(fetch, `${GBP_INFO}/${at}?${fields}`, bearer(access));
        return { externalId: extra.location, name: str(b.title), handle: null, extra };
      }
      const b = await json(fetch, GBP_ACCOUNTS, bearer(access));
      const a = ((b.accounts as Json[] | undefined) ?? [])[0];
      if (!a) throw new OAuthError("no_profile", "This Google account manages no Profile.", false);
      const l = await json(
        fetch,
        `${GBP_INFO}/${String(a.name)}/locations?${fields}&pageSize=100`,
        bearer(access),
      );
      const loc = ((l.locations as Json[] | undefined) ?? [])[0];
      if (!loc)
        throw new OAuthError(
          "no_profile",
          "This Google account manages no business location.",
          false,
        );
      const location = `${String(a.name)}/${String(loc.name)}`;
      return {
        externalId: location,
        name: str(loc.title) ?? str(a.accountName),
        handle: null,
        extra: { location },
      };
    }
  }
}
