/**
 * What every OAuth sign-in shares: one state and PKCE maker, one refusal, and one call to a token
 * endpoint. Each caller keeps its provider's quirks: scopes, URLs, and what a token answer means.
 * Tokens go back to the caller only, never into an error or a log line.
 *
 * Two error parsers live in this piece and stay two. `tokenPost` and `oauthErrorOf` are for mail
 * and connected apps (HubSpot, QuickBooks, Jobber): an RFC 6749 `{error, error_description}` body,
 * or HubSpot's `{status, message}`. `platformJson` and `platformErrorOf` (`./platform.ts`) are for
 * the social platforms: Meta's `{error: {code, message}}`, TikTok's `{error: {code: "ok"}}` and a
 * 401 that always means revoked. Each caller keeps the parser it has today.
 */
import { createHash, randomBytes } from "node:crypto";
import type { FetchLike } from "../clients/http.js";

export const randomState = () => randomBytes(24).toString("base64url");
export const pkceVerifier = () => randomBytes(48).toString("base64url");
export const pkceChallenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

/** A refusal from a sign-in or a token endpoint. `revoked`: the grant is gone; connect again. */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly revoked: boolean,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

const REVOKED = new Set([
  "invalid_grant",
  "invalid_token",
  "unauthorized_client",
  "interaction_required",
  "expired",
  // HubSpot answers {status, message}, not {error}.
  "BAD_REFRESH_TOKEN",
]);
/** Whether a provider's error code means the grant is gone. */
export const revokedCode = (code: string) => REVOKED.has(code);

/** The provider's code and the first line of its description, never the body. */
export function oauthErrorOf(status: number, body: Record<string, unknown>): OAuthError {
  const named = typeof body.error === "string" && body.error ? body.error : body.status;
  const code = typeof named === "string" && named ? named : `http_${status}`;
  // Microsoft's description starts "AADSTS70000: ..."; keep its first line, never more.
  const said = String(body.error_description ?? body.message ?? "")
    .split(/\r?\n/)[0]
    ?.slice(0, 200);
  return new OAuthError(code, said ? `${code}: ${said}` : code, revokedCode(code));
}

/** One OAuth app: the client id and secret the provider issued. */
export interface OAuthApp {
  id: string;
  secret: string;
}

/** One OAuth app, and how its keys reach the token endpoint. */
export interface OAuthClient extends OAuthApp {
  /** `basic`: an Authorization header. `body`: client_id and client_secret in the form. */
  as: "basic" | "body";
}

/** A form POSTed to a token endpoint: the answer's JSON, or an `OAuthError`. */
export async function tokenPost(
  fetch: FetchLike,
  url: string,
  form: Record<string, string>,
  client?: OAuthClient,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(form);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (client?.as === "basic")
    headers.authorization = `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}`;
  else if (client) {
    body.set("client_id", client.id);
    body.set("client_secret", client.secret);
  }
  const res = await fetch(url, { method: "POST", headers, body: body.toString() });
  const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof b.error === "string") throw oauthErrorOf(res.status, b);
  return b;
}

/** A JWT's claims, unverified: an id token straight from the token endpoint over TLS (OIDC 3.1.3.7). */
export function claimsOf(jwt: unknown): Record<string, unknown> {
  if (typeof jwt !== "string") return {};
  const part = jwt.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
