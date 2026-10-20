/**
 * Connected apps' sign-in (HubSpot, QuickBooks, Jobber): the link, the code's exchange, a refresh.
 * The caller passes the app's spec, so its UI copy stays with the caller. Every call goes through
 * `FetchLike`. Tokens go back to the caller only, never into an error or a log line. Errors come
 * from `tokenPost` (`./core.ts`), not the social parser.
 */
import type { FetchLike } from "../clients/http.js";
import { type OAuthApp, OAuthError, tokenPost } from "./core.js";

/** Where one app signs in and how its token endpoint wants the app's keys. */
export interface AppSpec {
  /** The app as a person says it; named in an error. */
  label: string;
  authorize: string;
  token: string;
  /** Asked for in the link; Jobber's are set on its developer app, so none. */
  scopes: readonly string[];
  /** How the token endpoint takes the app's id and secret. */
  auth: "body" | "basic";
}

export interface AppTokens {
  access: string;
  refresh: string;
  /** Seconds the access token lives. */
  expiresIn: number;
}

/** Where a person signs in to connect the app. */
export function appConnectUrl(
  spec: Pick<AppSpec, "authorize" | "scopes">,
  keys: OAuthApp,
  o: { redirect: string; state: string },
): string {
  const q = new URLSearchParams({
    client_id: keys.id,
    redirect_uri: o.redirect,
    state: o.state,
    response_type: "code",
  });
  if (spec.scopes.length) q.set("scope", spec.scopes.join(" "));
  return `${spec.authorize}?${q}`;
}

async function tokenCall(
  fetch: FetchLike,
  spec: AppSpec,
  keys: OAuthApp,
  form: Record<string, string>,
): Promise<AppTokens> {
  const j = await tokenPost(fetch, spec.token, form, {
    ...keys,
    as: spec.auth === "basic" ? "basic" : "body",
  });
  if (typeof j.access_token !== "string")
    throw new OAuthError("no_access", `${spec.label} gave no access token`, false);
  const refresh = typeof j.refresh_token === "string" ? j.refresh_token : form.refresh_token;
  if (!refresh) throw new OAuthError("no_refresh", `${spec.label} gave no refresh token`, false);
  const exp = Number(j.expires_in);
  return {
    access: j.access_token,
    refresh,
    expiresIn: Number.isFinite(exp) && exp > 0 ? exp : 3600,
  };
}

/** The code the app sent back, for tokens. */
export const appExchange = (
  fetch: FetchLike,
  spec: AppSpec,
  keys: OAuthApp,
  o: { code: string; redirect: string },
) =>
  tokenCall(fetch, spec, keys, {
    grant_type: "authorization_code",
    code: o.code,
    redirect_uri: o.redirect,
  });

/** A fresh access token. QuickBooks and Jobber hand back a new refresh token: keep it. */
export const appRefresh = (fetch: FetchLike, spec: AppSpec, keys: OAuthApp, token: string) =>
  tokenCall(fetch, spec, keys, { grant_type: "refresh_token", refresh_token: token });
