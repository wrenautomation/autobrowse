/**
 * Service-account bearer tokens over `fetch`, signed with `node:crypto`.
 * `subject` mints a domain-wide-delegation token acting AS that user (the
 * Workspace super admin for Directory calls, each inbox for Gmail settings).
 * Copied from wren's channel-email rather than imported: the two repos
 * share no code by design.
 */
import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const SCOPES = {
  directoryDomain: "https://www.googleapis.com/auth/admin.directory.domain",
  directoryUser: "https://www.googleapis.com/auth/admin.directory.user",
  siteVerification: "https://www.googleapis.com/auth/siteverification",
  gmailSettings: "https://www.googleapis.com/auth/gmail.settings.basic",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
} as const;

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const TOKEN_LIFETIME_S = 3600;
const REFRESH_MARGIN_MS = 60_000;

export class ServiceAccountKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceAccountKeyError";
  }
}

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

/** `path` is the key file, or the key's JSON itself. The value is never echoed. */
export function loadServiceAccountKey(
  path: string,
  envName = "GOOGLE_SERVICE_ACCOUNT",
): ServiceAccountKey {
  if (path.trimStart().startsWith("{")) {
    try {
      return parseServiceAccountKey(JSON.parse(path), envName);
    } catch (err) {
      if (err instanceof ServiceAccountKeyError) throw err;
      throw new ServiceAccountKeyError(`${envName} holds JSON that does not parse`);
    }
  }
  const expanded = expandHome(path);
  if (!existsSync(expanded)) {
    throw new ServiceAccountKeyError(
      `service account key not found at ${expanded} — set ${envName}`,
    );
  }
  try {
    return parseServiceAccountKey(JSON.parse(readFileSync(expanded, "utf8")), expanded);
  } catch (err) {
    if (err instanceof ServiceAccountKeyError) throw err;
    throw new ServiceAccountKeyError(`${expanded} is not a usable service-account key`);
  }
}

export function parseServiceAccountKey(raw: unknown, where: string): ServiceAccountKey {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const { client_email: clientEmail, private_key: privateKey } = r;
  const tokenUri = r.token_uri ?? DEFAULT_TOKEN_URI;
  if (
    r.type !== "service_account" ||
    typeof clientEmail !== "string" ||
    typeof privateKey !== "string" ||
    typeof tokenUri !== "string"
  ) {
    throw new ServiceAccountKeyError(`${where} is not a usable service-account key`);
  }
  return { clientEmail, privateKey, tokenUri };
}

export type TokenSupplier = () => Promise<string>;

export interface TokenOptions {
  readonly scopes: readonly string[];
  readonly subject?: string | null;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
}

const base64url = (data: Buffer | string): string => Buffer.from(data).toString("base64url");

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
  return `${header}.${payload}.${signer.sign(key.privateKey, "base64url")}`;
}

/** Lazily minted, refreshed a minute before expiry. Safe to hold for a whole run. */
export function serviceAccountToken(key: ServiceAccountKey, opts: TokenOptions): TokenSupplier {
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? (() => new Date());
  let cached: { token: string; expiresAt: number } | null = null;
  return async () => {
    const at = now();
    if (cached && cached.expiresAt - at.getTime() > REFRESH_MARGIN_MS) return cached.token;
    const form = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signAssertion(key, opts, at),
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
      throw new TokenRefreshError(response.status, "no access_token", opts.subject ?? null);
    }
    const ttl = typeof body.expires_in === "number" ? body.expires_in : TOKEN_LIFETIME_S;
    cached = { token: body.access_token, expiresAt: at.getTime() + ttl * 1000 };
    return cached.token;
  };
}

/** A JSON call with a bearer; the bearer never reaches a URL or an error message. */
export async function authedJson<T>(
  doFetch: FetchLike,
  token: TokenSupplier,
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T | null }> {
  const response = await doFetch(url, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${await token()}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  let body: T | null = null;
  try {
    body = text ? (JSON.parse(text) as T) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}
