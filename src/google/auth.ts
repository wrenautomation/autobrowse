/**
 * Service-account bearer tokens over `fetch`, no google-auth library. The
 * OAuth JWT-bearer assertion is signed from the key file with `node:crypto`
 * (RS256); `subject` mints a domain-wide-delegation token acting AS that
 * user (the Workspace admin for Directory calls, each inbox for Gmail). The bearer never appears in a URL
 * or an error message.
 */

import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { FetchLike, HttpClient, JsonResponse } from "../clients/http.js";

/** The Google scopes autobrowse and its callers ask for, by what they are for. */
export const SCOPES = {
  directoryDomain: "https://www.googleapis.com/auth/admin.directory.domain",
  directoryUser: "https://www.googleapis.com/auth/admin.directory.user",
  siteVerification: "https://www.googleapis.com/auth/siteverification",
  gmailSettings: "https://www.googleapis.com/auth/gmail.settings.basic",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
  gmailModify: "https://www.googleapis.com/auth/gmail.modify",
} as const;

/**
 * Domain-wide delegation grants exact scopes, not supersets: the sender
 * service account is delegated `gmail.modify` (send + read + label), not
 * `gmail.readonly`, so a read through it asks for modify. Consent tokens
 * are untouched (they were granted readonly).
 */
export function delegatedScopes(scopes: readonly string[]): string[] {
  return scopes.map((s) => (s === SCOPES.gmailRead ? SCOPES.gmailModify : s));
}

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
/** Must be modify, not readonly: the delegation entry authorizes send + modify. */
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const POSTMASTER_TRAFFIC_SCOPE =
  "https://www.googleapis.com/auth/postmaster.traffic.readonly";
export const POSTMASTER_SCOPE = "https://www.googleapis.com/auth/postmaster";

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const TOKEN_LIFETIME_S = 3600;
const REFRESH_MARGIN_MS = 60_000;

/** The key file is absent or not loadable: configuration trouble, not a per-call failure. */
export class ServiceAccountKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceAccountKeyError";
  }
}

/** Google answered the token exchange and declined (delegation not authorized, bad scope). */
export class TokenRefreshError extends Error {
  readonly status: number;
  constructor(status: number, detail: string, subject: string | null) {
    super(`token exchange refused (HTTP ${status})${subject ? ` for ${subject}` : ""}: ${detail}`);
    this.name = "TokenRefreshError";
    this.status = status;
  }
}

export interface ServiceAccountKey {
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly tokenUri: string;
}

export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

/** The other way: a path under the home folder as `~/...`, for what a terminal shows. */
export function shortHome(path: string, home = homedir()): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * Read and check the JSON key Google Cloud issues for a service account. `path`
 * is the key file, or — for hosts with no filesystem to keep one on (Lambda) —
 * the key's JSON itself. The value is never echoed: an error names the env var.
 */
export function loadServiceAccountKey(
  path: string,
  envName = "GOOGLE_SERVICE_ACCOUNT",
): ServiceAccountKey {
  if (path.trimStart().startsWith("{")) {
    let raw: unknown;
    try {
      raw = JSON.parse(path);
    } catch (err) {
      throw new ServiceAccountKeyError(
        `${envName} holds JSON that does not parse (${(err as Error).message})`,
      );
    }
    return parseServiceAccountKey(raw, envName);
  }
  const expanded = expandHome(path);
  if (!existsSync(expanded)) {
    throw new ServiceAccountKeyError(
      `service account key not found at ${expanded} — set ${envName} to the JSON key file's path`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(expanded, "utf8"));
  } catch (err) {
    throw new ServiceAccountKeyError(
      `${expanded} is not a usable service-account key (${(err as Error).message}) — download the ` +
        "service account's own JSON key from Google Cloud, not an OAuth client secret",
    );
  }
  return parseServiceAccountKey(raw, expanded);
}

export function parseServiceAccountKey(raw: unknown, where: string): ServiceAccountKey {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const clientEmail = r.client_email;
  const privateKey = r.private_key;
  const tokenUri = r.token_uri ?? DEFAULT_TOKEN_URI;
  if (
    r.type !== "service_account" ||
    typeof clientEmail !== "string" ||
    typeof privateKey !== "string" ||
    typeof tokenUri !== "string"
  ) {
    throw new ServiceAccountKeyError(
      `${where} is not a usable service-account key (missing type/client_email/private_key) — download the ` +
        "service account's own JSON key from Google Cloud, not an OAuth client secret",
    );
  }
  return { clientEmail, privateKey, tokenUri };
}

export type { FetchLike };

/** A bearer supplier: mints lazily, refreshes on expiry. Never hand the string itself around. */
export type TokenSupplier = () => Promise<string>;

export interface TokenOptions {
  readonly scopes: readonly string[];
  /** The user to act as (domain-wide delegation). */
  readonly subject?: string | null;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
}

function base64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

/** The signed JWT-bearer assertion for one exchange. */
export function signAssertion(key: ServiceAccountKey, opts: TokenOptions, issuedAt: Date): string {
  const iat = Math.floor(issuedAt.getTime() / 1000);
  const claims: Record<string, unknown> = {
    iss: key.clientEmail,
    scope: opts.scopes.join(" "),
    aud: key.tokenUri,
    iat,
    exp: iat + TOKEN_LIFETIME_S,
  };
  if (opts.subject) claims.sub = opts.subject;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  let signature: string;
  try {
    signature = signer.sign(key.privateKey, "base64url");
  } catch (err) {
    throw new ServiceAccountKeyError(
      `the service-account private key cannot sign: ${(err as Error).message}`,
    );
  }
  return `${header}.${payload}.${signature}`;
}

/**
 * Callable bearer-token supplier for one service account + scope set (+
 * subject). Refreshes lazily a minute before expiry; safe to hold for a
 * whole run. Network failures propagate as the fetch error; a refusal from
 * Google is a `TokenRefreshError`.
 */
export function serviceAccountToken(key: ServiceAccountKey, opts: TokenOptions): TokenSupplier {
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? (() => new Date());
  let cached: { token: string; expiresAt: number } | null = null;
  return async () => {
    const at = now();
    if (cached && cached.expiresAt - at.getTime() > REFRESH_MARGIN_MS) return cached.token;
    const assertion = signAssertion(key, opts, at);
    const form = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });
    const response = await doFetch(key.tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 200);
      try {
        const parsed = JSON.parse(text) as { error?: string; error_description?: string };
        detail = [parsed.error, parsed.error_description].filter(Boolean).join(": ") || detail;
      } catch {
        // keep the raw excerpt
      }
      throw new TokenRefreshError(response.status, detail, opts.subject ?? null);
    }
    const body = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (typeof body.access_token !== "string") {
      throw new TokenRefreshError(
        response.status,
        "no access_token in the response",
        opts.subject ?? null,
      );
    }
    const ttl = typeof body.expires_in === "number" ? body.expires_in : TOKEN_LIFETIME_S;
    cached = { token: body.access_token, expiresAt: at.getTime() + ttl * 1000 };
    return cached.token;
  };
}

/**
 * A Postmaster credential on the narrowest scope the delegation actually
 * grants. `postmaster.traffic.readonly` is all the harness needs; the broad
 * `postmaster` also carries domain creation and user management. Which one is
 * available is a property of the admin console's entry, not of this code, so
 * try the narrow one and fall back rather than making a console change into a
 * code change. A refusal is Google declining to mint the token at all.
 */
export async function postmasterToken(
  key: ServiceAccountKey,
  subject: string,
  opts: { fetch?: FetchLike; now?: () => Date } = {},
): Promise<TokenSupplier> {
  for (const scope of [POSTMASTER_TRAFFIC_SCOPE, POSTMASTER_SCOPE]) {
    const supplier = serviceAccountToken(key, { scopes: [scope], subject, ...opts });
    try {
      await supplier();
    } catch (err) {
      if (err instanceof TokenRefreshError) continue;
      throw err;
    }
    return supplier;
  }
  throw new ServiceAccountKeyError(
    `the domain-wide-delegation entry grants neither ${POSTMASTER_TRAFFIC_SCOPE} nor ${POSTMASTER_SCOPE} for ${subject} — add one (the first is narrower and preferred) beside the Gmail scopes in the Workspace admin console`,
  );
}

/** A JSON call with a bearer; the bearer never reaches a URL or an error message. */
export async function authedJson<T>(
  http: HttpClient,
  token: TokenSupplier,
  url: string,
  init: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown } = {},
): Promise<JsonResponse<T>> {
  return http.json<T>(url, {
    ...(init.method ? { method: init.method } : {}),
    ...(init.body === undefined ? {} : { body: init.body }),
    headers: { authorization: `Bearer ${await token()}` },
  });
}
