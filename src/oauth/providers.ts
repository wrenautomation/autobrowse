/**
 * Each OAuth provider's URLs and how it wants a client, written once. wren's sign-ins and
 * autobrowse's site consents both read this table, so a URL never has two copies. Scopes, labels
 * and copy are the caller's: they are product choices.
 */
import { pkceChallenge } from "./core.js";

export type OAuthProvider =
  | "google"
  | "microsoft"
  | "meta"
  | "linkedin"
  | "x"
  | "tiktok"
  | "instagram"
  | "threads";

export interface ProviderSpec {
  /** Microsoft's holds `{tenant}`; read it through `authorizeEndpoint`. */
  authorize: string;
  /** Microsoft's holds `{tenant}`; read it through `tokenEndpoint`. */
  token: string;
  /** The query and form name the client id travels as; TikTok says `client_key`. */
  clientIdParam: "client_id" | "client_key";
  /** Between scopes on the authorize URL: a space unless the provider wants commas. */
  scopeSeparator: " " | ",";
  /** `basic`: a Basic header and the id alone in the form. `body`: the id and secret in the form. */
  clientAuth: "body" | "basic";
  /** Whether the provider takes PKCE (S256) on the authorize URL and the exchange. */
  pkce: boolean;
  /** Query the authorize URL always carries; a caller's `params` win. */
  params?: Record<string, string>;
}

const META_V = "v23.0";
export const MICROSOFT_LOGIN = "https://login.microsoftonline.com";

export const OAUTH_PROVIDERS: Record<OAuthProvider, ProviderSpec> = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    clientIdParam: "client_id",
    scopeSeparator: " ",
    clientAuth: "body",
    pkce: true,
    // A refresh token every time, and only the scopes asked now.
    params: { access_type: "offline", prompt: "consent", include_granted_scopes: "false" },
  },
  microsoft: {
    authorize: `${MICROSOFT_LOGIN}/{tenant}/oauth2/v2.0/authorize`,
    token: `${MICROSOFT_LOGIN}/{tenant}/oauth2/v2.0/token`,
    clientIdParam: "client_id",
    scopeSeparator: " ",
    clientAuth: "body",
    pkce: true,
  },
  // Facebook Login: a Page and its Instagram professional account.
  meta: {
    authorize: `https://www.facebook.com/${META_V}/dialog/oauth`,
    token: `https://graph.facebook.com/${META_V}/oauth/access_token`,
    clientIdParam: "client_id",
    scopeSeparator: ",",
    clientAuth: "body",
    pkce: false,
  },
  linkedin: {
    authorize: "https://www.linkedin.com/oauth/v2/authorization",
    token: "https://www.linkedin.com/oauth/v2/accessToken",
    clientIdParam: "client_id",
    scopeSeparator: " ",
    clientAuth: "body",
    pkce: false,
  },
  x: {
    authorize: "https://x.com/i/oauth2/authorize",
    token: "https://api.x.com/2/oauth2/token",
    clientIdParam: "client_id",
    scopeSeparator: " ",
    clientAuth: "basic",
    pkce: true,
  },
  tiktok: {
    authorize: "https://www.tiktok.com/v2/auth/authorize/",
    token: "https://open.tiktokapis.com/v2/oauth/token/",
    clientIdParam: "client_key",
    scopeSeparator: ",",
    clientAuth: "body",
    pkce: false,
  },
  // Instagram Login (no Facebook Page).
  instagram: {
    authorize: "https://www.instagram.com/oauth/authorize",
    token: "https://api.instagram.com/oauth/access_token",
    clientIdParam: "client_id",
    scopeSeparator: ",",
    clientAuth: "body",
    pkce: false,
  },
  threads: {
    authorize: "https://threads.net/oauth/authorize",
    token: "https://graph.threads.net/oauth/access_token",
    clientIdParam: "client_id",
    scopeSeparator: ",",
    clientAuth: "body",
    pkce: false,
  },
};

/** A tenant in a URL: a GUID or a domain, nothing else. */
const TENANT = /^[a-z0-9][a-z0-9.-]{0,253}$/i;
/** Microsoft's tenant: a domain, a tenant id, `common`; none means any work account. */
export function tenantOf(t: string | null | undefined): string {
  const v = (t ?? "organizations").trim();
  if (!TENANT.test(v)) throw new Error("tenant: a domain or a tenant id");
  return v;
}

const resolved = (url: string, tenant: string | null | undefined) =>
  url.includes("{tenant}") ? url.replace("{tenant}", tenantOf(tenant)) : url;

/** The provider's authorize URL; Microsoft's takes a tenant. */
export const authorizeEndpoint = (provider: OAuthProvider, tenant?: string | null): string =>
  resolved(OAUTH_PROVIDERS[provider].authorize, tenant);

/** The provider's token URL; Microsoft's takes a tenant. */
export const tokenEndpoint = (provider: OAuthProvider, tenant?: string | null): string =>
  resolved(OAUTH_PROVIDERS[provider].token, tenant);

/** Where a person signs in: the provider's authorize URL with the query its sign-in wants. */
export function authorizeUrl(
  provider: OAuthProvider,
  clientId: string,
  o: {
    redirect: string;
    state: string;
    scopes: readonly string[];
    /** PKCE's verifier: its challenge goes on the URL when the provider takes PKCE. */
    verifier?: string | null;
    /** Over the provider's own (`login_hint`, `hd`, `prompt`). */
    params?: Record<string, string>;
    /** Microsoft only. */
    tenant?: string | null;
  },
): string {
  const p = OAUTH_PROVIDERS[provider];
  const q = new URLSearchParams({
    redirect_uri: o.redirect,
    state: o.state,
    response_type: "code",
  });
  q.set(p.clientIdParam, clientId);
  if (o.scopes.length) q.set("scope", o.scopes.join(p.scopeSeparator));
  if (p.pkce && o.verifier) {
    q.set("code_challenge", pkceChallenge(o.verifier));
    q.set("code_challenge_method", "S256");
  }
  for (const [k, v] of Object.entries({ ...p.params, ...o.params })) q.set(k, v);
  return `${authorizeEndpoint(provider, o.tenant)}?${q}`;
}
