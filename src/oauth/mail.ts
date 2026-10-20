/**
 * Mail's OAuth: Google's and Microsoft's authorization-code flow with PKCE, refresh, Microsoft's
 * admin consent, and its app token for the consent check. Every call goes through `FetchLike`.
 * Tokens are returned to the caller, never logged; errors carry the provider's code, never a
 * token. Errors come from `tokenPost` (`./core.ts`), not the social parser. The two `why` lines of
 * `appInTenant` are said to a person and keep wren's words.
 */
import type { FetchLike } from "../clients/http.js";
import { claimsOf, type OAuthApp, type OAuthError, tokenPost } from "./core.js";
import { authorizeUrl, MICROSOFT_LOGIN, tenantOf, tokenEndpoint } from "./providers.js";

export type MailProvider = "google" | "microsoft";
/** What a mailbox grant lets the app do: read and send, or send only. */
export type MailAccess = "read" | "send";

export const GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
export const GRAPH_READ = "https://graph.microsoft.com/Mail.Read";
export const GRAPH_SEND = "https://graph.microsoft.com/Mail.Send";
/** Who signed in: the address, and Google's `hd` or Microsoft's `tid`. */
const IDENTITY = ["openid", "email"];

/** The scopes a connect asks for. Read always comes with send: one sign-in, both jobs. */
export function scopesFor(provider: MailProvider, want: MailAccess): string[] {
  if (provider === "google")
    return [...IDENTITY, ...(want === "read" ? [GMAIL_READ] : []), GMAIL_SEND];
  return [...IDENTITY, "offline_access", ...(want === "read" ? [GRAPH_READ] : []), GRAPH_SEND];
}

/** What a set of granted scopes lets the app do; null when it can't even send. */
export function accessOf(provider: MailProvider, granted: readonly string[]): MailAccess | null {
  const has = (s: string) => granted.some((g) => g.toLowerCase() === s.toLowerCase());
  const [read, send] = provider === "google" ? [GMAIL_READ, GMAIL_SEND] : [GRAPH_READ, GRAPH_SEND];
  if (!has(send)) return null;
  return has(read) ? "read" : "send";
}

/** Microsoft names Graph scopes bare in a token's `scope` ("Mail.Read"); the URL form is the same. */
export const graphScopes = (scope: string) =>
  scope
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => (/^Mail\.(Read|Send)$/i.test(s) ? `https://graph.microsoft.com/${s}` : s));

/** Personal Google accounts: no Workspace admin can trust the app for them. */
export const CONSUMER_GOOGLE = new Set(["gmail.com", "googlemail.com"]);
/** Personal Microsoft accounts: no tenant, no admin consent. Not supported yet. */
export const CONSUMER_MICROSOFT = new Set(["outlook.com", "hotmail.com", "live.com", "msn.com"]);

/** Where a person signs in to connect one mailbox. */
export function mailConnectUrl(
  provider: MailProvider,
  app: OAuthApp,
  o: {
    redirect: string;
    state: string;
    verifier: string;
    want: MailAccess;
    address: string;
    /** Microsoft: the org's domain or tenant id; none: any work account. */
    tenant?: string | null;
  },
): string {
  const at = {
    redirect: o.redirect,
    state: o.state,
    scopes: scopesFor(provider, o.want),
    verifier: o.verifier,
  };
  if (provider === "google") {
    const domain = o.address.split("@")[1] ?? "";
    return authorizeUrl("google", app.id, {
      ...at,
      params: {
        login_hint: o.address,
        ...(domain && !CONSUMER_GOOGLE.has(domain) ? { hd: domain } : {}),
      },
    });
  }
  return authorizeUrl("microsoft", app.id, {
    ...at,
    ...(o.tenant !== undefined ? { tenant: o.tenant } : {}),
    params: { login_hint: o.address, response_mode: "query", prompt: "select_account" },
  });
}

/**
 * Microsoft's admin consent for the tenant (v2 endpoint): the scopes are named here, so the admin
 * sees exactly Mail.Read, Mail.Send and offline_access, whatever the registration lists.
 */
export function mailConsentUrl(
  app: OAuthApp,
  o: { tenant: string; redirect: string; state: string },
): string {
  const q = new URLSearchParams({
    client_id: app.id,
    scope: [GRAPH_READ, GRAPH_SEND, "offline_access", ...IDENTITY].join(" "),
    redirect_uri: o.redirect,
    state: o.state,
  });
  return `${MICROSOFT_LOGIN}/${tenantOf(o.tenant)}/v2.0/adminconsent?${q}`;
}

export interface MailTokens {
  access: string;
  /** Seconds the access token lives. */
  expiresIn: number;
  /** Microsoft sends a new one on every refresh; Google only on the first exchange. */
  refresh: string | null;
  scopes: string[];
  /** The signed-in address, lowercased, when an id token came. */
  address: string | null;
  /** Google's `hd` (Workspace domain) or Microsoft's `tid`. */
  org: string | null;
}

function tokensOf(provider: MailProvider, b: Record<string, unknown>): MailTokens {
  const claims = claimsOf(b.id_token);
  const email = String(claims.email ?? claims.preferred_username ?? "").toLowerCase();
  const scope = String(b.scope ?? "");
  return {
    access: String(b.access_token ?? ""),
    expiresIn: Number(b.expires_in ?? 3600),
    refresh: typeof b.refresh_token === "string" ? b.refresh_token : null,
    scopes: provider === "microsoft" ? graphScopes(scope) : scope.split(/\s+/).filter(Boolean),
    address: email.includes("@") ? email : null,
    org: provider === "google" ? ((claims.hd as string) ?? null) : ((claims.tid as string) ?? null),
  };
}

/** The code from the callback, for tokens. */
export async function mailExchange(
  fetch: FetchLike,
  provider: MailProvider,
  app: OAuthApp,
  o: { code: string; redirect: string; verifier: string; tenant?: string | null },
): Promise<MailTokens> {
  const b = await tokenPost(fetch, tokenEndpoint(provider, o.tenant), {
    grant_type: "authorization_code",
    code: o.code,
    redirect_uri: o.redirect,
    client_id: app.id,
    client_secret: app.secret,
    code_verifier: o.verifier,
  });
  return tokensOf(provider, b);
}

/** A fresh access token. Microsoft rotates the refresh token: the caller keeps the new one. */
export async function mailRefresh(
  fetch: FetchLike,
  provider: MailProvider,
  app: OAuthApp,
  o: { refresh: string; tenant?: string | null },
): Promise<MailTokens> {
  const b = await tokenPost(fetch, tokenEndpoint(provider, o.tenant), {
    grant_type: "refresh_token",
    refresh_token: o.refresh,
    client_id: app.id,
    client_secret: app.secret,
  });
  return tokensOf(provider, b);
}

/**
 * Whether the Microsoft app is in the tenant: an app-only token is issued only where its
 * service principal exists, which an admin's consent creates. The token itself is dropped.
 */
export async function appInTenant(
  fetch: FetchLike,
  app: OAuthApp,
  tenant: string,
): Promise<{ ok: boolean; why: string }> {
  try {
    await tokenPost(fetch, tokenEndpoint("microsoft", tenant), {
      grant_type: "client_credentials",
      client_id: app.id,
      client_secret: app.secret,
      scope: "https://graph.microsoft.com/.default",
    });
    return { ok: true, why: "Wren's app is in the tenant" };
  } catch (err) {
    const e = err as OAuthError;
    // AADSTS700016: the app isn't in that directory; consent was never given or was removed.
    return /AADSTS700016/.test(e.message)
      ? { ok: false, why: "Wren's app isn't in the tenant: the admin hasn't consented" }
      : { ok: false, why: `Microsoft said ${e.code ?? "no"}` };
  }
}
