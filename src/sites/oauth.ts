/**
 * OAuth 2.0 the way a site API needs it: mint an access token from a
 * refresh token (code, no browser), and get that refresh token once by
 * driving the consent page in the site's logged-in profile with the
 * redirect caught on loopback. Tokens travel in bodies and headers only;
 * nothing here logs a value.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { type HttpClient, HttpError } from "../clients/http.js";
import type { OAuthSpec } from "./types.js";

interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

async function tokenCall(
  http: HttpClient,
  url: string,
  fields: Record<string, string>,
  method: "POST" | "GET" = "POST",
  headers: Record<string, string> = {},
) {
  const res =
    method === "GET"
      ? await http.json<TokenBody>(`${url}?${form(fields)}`, { headers })
      : await http.json<TokenBody>(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
          raw: form(fields),
        });
  if (!res.ok || !res.body?.access_token) {
    const why = res.body?.error ? `${res.body.error}: ${res.body.error_description ?? ""}` : "";
    throw new HttpError("POST", url, res.status, why.trim());
  }
  return res.body;
}

/**
 * The env name a token is kept under for one account of a site:
 * `GMAIL_REFRESH_TOKEN` for the site's own, `GMAIL_REFRESH_TOKEN__WILL_X_DEV`
 * for will@x.dev. One site, any number of identities.
 */
/** The client on a token call: form fields, or a Basic header with the id alone in the form. */
function clientFields(
  spec: OAuthSpec,
  id: string,
  secret: string,
): { fields: Record<string, string>; headers: Record<string, string> } {
  const idParam = spec.clientIdParam ?? "client_id";
  if (spec.tokenAuth === "basic")
    return {
      fields: { [idParam]: id },
      headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` },
    };
  return { fields: { [idParam]: id, client_secret: secret }, headers: {} };
}

/** PKCE: a verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function accountEnv(name: string, account?: string | null): string {
  if (!account) return name;
  return `${name}__${account
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .toUpperCase()}`;
}

/**
 * An access token: minted from the refresh token when there is one (cached
 * until a minute before it expires), else the kept access token itself.
 * With `account`, that account's tokens (see `accountEnv`).
 */
export function accessTokens(
  http: HttpClient,
  env: (name: string) => string | undefined,
  now: () => number = Date.now,
  /** Told when a mint answers a new refresh token (X rolls them): keep it under that name. */
  keep?: (name: string, value: string) => Promise<void>,
): (spec: OAuthSpec, account?: string | null) => Promise<string | null> {
  const cache = new Map<string, { token: string; until: number }>();
  return async (spec, account) => {
    const refreshName = accountEnv(spec.refreshToken, account);
    const refresh = env(refreshName);
    const id = env(spec.clientId);
    const secret = env(spec.clientSecret);
    if (!refresh || !id || !secret)
      return (spec.accessToken && env(accountEnv(spec.accessToken, account))) || null;
    const hit = cache.get(refreshName);
    if (hit && hit.until > now()) return hit.token;
    const client = clientFields(spec, id, secret);
    const body = await tokenCall(
      http,
      spec.tokenUrl,
      { grant_type: "refresh_token", refresh_token: refresh, ...client.fields },
      "POST",
      client.headers,
    );
    const token = body.access_token as string;
    cache.set(refreshName, { token, until: now() + ((body.expires_in ?? 3600) - 60) * 1000 });
    if (keep && body.refresh_token && body.refresh_token !== refresh)
      await keep(refreshName, body.refresh_token);
    return token;
  };
}

export interface ConsentInput {
  /** The authorize URL to open; the flow logs in and clicks allow. */
  url: string;
  /** Which account consents, when the site's chooser lists several. */
  account?: string;
}

/**
 * The one-time consent: a loopback listener takes the redirect, the flow
 * opens the authorize URL in the site's profile and clicks through, the
 * code is exchanged for tokens. Returns the refresh token to keep.
 */
export async function runConsent(
  spec: OAuthSpec,
  o: {
    http: HttpClient;
    env: (name: string) => string | undefined;
    /** Opens the authorize URL in the site's logged-in profile and clicks through to the redirect. */
    open: (input: ConsentInput) => Promise<unknown>;
    /** Which account consents (the chooser's pick; the token is kept under its own name). */
    account?: string | null;
    /** Loopback port for the redirect; must match the client's registered redirect URI. */
    port?: number;
    timeoutMs?: number;
  },
): Promise<{ refreshToken: string | null; accessToken: string; expiresIn: number | null }> {
  const id = o.env(spec.clientId);
  const secret = o.env(spec.clientSecret);
  if (!id || !secret)
    throw new Error(`consent needs ${spec.clientId} and ${spec.clientSecret} first`);
  const port = o.port ?? 9400;
  const redirect = `http://127.0.0.1:${port}/oauth/callback`;
  const state = randomBytes(16).toString("hex");
  const code = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("consent: no redirect within the time allowed"));
    }, o.timeoutMs ?? 300_000);
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", redirect);
      if (u.pathname !== "/oauth/callback") {
        res.writeHead(404).end();
        return;
      }
      const got = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      res
        .writeHead(200, { "content-type": "text/plain" })
        .end(
          got
            ? "autobrowse: consent received, you can close this tab"
            : `autobrowse: ${err ?? "no code"}`,
        );
      clearTimeout(timer);
      server.close();
      if (u.searchParams.get("state") !== state) reject(new Error("consent: state mismatch"));
      else if (got) resolve(got);
      else reject(new Error(`consent refused: ${err ?? "no code"}`));
    });
    server.listen(port, "127.0.0.1");
  });
  const url = new URL(spec.authorizeUrl);
  const idParam = spec.clientIdParam ?? "client_id";
  const pkce = spec.pkce ? pkcePair() : null;
  for (const [k, v] of Object.entries({
    response_type: "code",
    [idParam]: id,
    redirect_uri: redirect,
    scope: spec.scopes.join(spec.scopeSeparator ?? " "),
    state,
    ...(pkce ? { code_challenge: pkce.challenge, code_challenge_method: "S256" } : {}),
    ...(spec.params ?? {}),
  }))
    url.searchParams.set(k, v);
  await Promise.all([
    o.open({ url: url.toString(), ...(o.account ? { account: o.account } : {}) }),
    code,
  ]);
  const client = clientFields(spec, id, secret);
  const body = await tokenCall(
    o.http,
    spec.tokenUrl,
    {
      grant_type: "authorization_code",
      code: await code,
      redirect_uri: redirect,
      ...client.fields,
      ...(pkce ? { code_verifier: pkce.verifier } : {}),
    },
    "POST",
    client.headers,
  );
  let accessToken = body.access_token as string;
  let expiresIn = body.expires_in ?? null;
  if (spec.longLived) {
    const long = await tokenCall(
      o.http,
      spec.longLived.url,
      {
        ...spec.longLived.fields,
        ...(spec.longLived.clientIdParam ? { [spec.longLived.clientIdParam]: id } : {}),
        client_secret: secret,
        [spec.longLived.tokenParam]: accessToken,
      },
      "GET",
    );
    accessToken = long.access_token as string;
    expiresIn = long.expires_in ?? null;
  }
  // How long the access token lives: a site that keeps no refresh token keeps this date with it.
  return { refreshToken: body.refresh_token ?? null, accessToken, expiresIn };
}
