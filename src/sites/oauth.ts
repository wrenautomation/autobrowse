/**
 * OAuth 2.0 the way a site API needs it: mint an access token from a
 * refresh token (code, no browser), and get that refresh token once by
 * driving the consent page in the site's logged-in profile with the
 * redirect caught on loopback. Tokens travel in bodies and headers only;
 * nothing here logs a value.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { CONSENT_RECEIVED } from "../browser/flows/oauth-consent.js";
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

/**
 * The https redirect a site that refuses http or localhost registers (Meta,
 * Instagram, TikTok). The browser answers it, so nothing on the site serves it.
 */
export const WEB_REDIRECT = "https://wrenautomation.com/oauth/callback";

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

const POINTER = "=>";

/** What an alias name holds instead of a second copy of a refresh token: the real name. */
export const pointTo = (name: string) => `${POINTER}${name}`;

/** The name a pointer value names, or null for a real value. */
export const pointedAt = (value: string | undefined): string | null =>
  value?.startsWith(POINTER) ? value.slice(POINTER.length) : null;

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
    const asked = accountEnv(spec.refreshToken, account);
    // An alias names the real copy (`pointTo`): mint from it and keep the new one there.
    const refreshName = pointedAt(env(asked)) ?? asked;
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
 * The code from where the consent landed (`?code=…&state=…`), or null when
 * the URL is not the redirect. A refusal or a foreign state throws.
 */
export function codeFrom(landed: string, redirect: string, state: string): string | null {
  if (!landed.startsWith(redirect)) return null;
  const u = new URL(landed);
  const got = u.searchParams.get("code");
  if (!got)
    throw new Error(
      `consent refused: ${u.searchParams.get("error_description") ?? u.searchParams.get("error_message") ?? u.searchParams.get("error") ?? `no code (params: ${[...u.searchParams.keys()].join(", ") || "none"}; ${u.hash ? "a fragment" : "no fragment"})`}`,
    );
  if (u.searchParams.get("state") !== state) throw new Error("consent: state mismatch");
  return got;
}

/** A listener on the http loopback redirect: the code it is handed, and how to stop it. */
function listen(redirect: string, state: string, timeoutMs: number) {
  let close = () => {};
  const code = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      close();
      reject(new Error("consent: no redirect within the time allowed"));
    }, timeoutMs);
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", redirect);
      if (u.pathname !== new URL(redirect).pathname) {
        res.writeHead(404).end();
        return;
      }
      const err = u.searchParams.get("error");
      res
        .writeHead(200, { "content-type": "text/plain" })
        .end(u.searchParams.get("code") ? CONSENT_RECEIVED : `autobrowse: ${err ?? "no code"}`);
      close();
      try {
        const got = codeFrom(u.toString(), redirect, state);
        if (got) resolve(got);
      } catch (e) {
        reject(e);
      }
    });
    close = () => {
      clearTimeout(timer);
      server.close();
    };
    const at = new URL(redirect);
    server.listen(Number(at.port), at.hostname);
  });
  return { code, close };
}

/**
 * The one-time consent: the flow opens the authorize URL in the site's
 * profile and clicks through; the code comes back in the URL it landed on
 * (the browser answers the redirect itself), or to a loopback listener on
 * an http redirect (a person finishing a hand-off). It is exchanged for
 * tokens. Returns the refresh token to keep.
 */
export async function runConsent(
  spec: OAuthSpec,
  o: {
    http: HttpClient;
    env: (name: string) => string | undefined;
    /** Opens the authorize URL in the site's logged-in profile and clicks through to the redirect; answers `{landed}`. */
    open: (input: ConsentInput) => Promise<unknown>;
    /** Which account consents (the chooser's pick; the token is kept under its own name). */
    account?: string | null;
    /** Loopback port for an http redirect; must match the client's registered redirect URI. */
    port?: number;
    timeoutMs?: number;
  },
): Promise<{ refreshToken: string | null; accessToken: string; expiresIn: number | null }> {
  const id = o.env(spec.clientId);
  const secret = o.env(spec.clientSecret);
  if (!id || !secret)
    throw new Error(`consent needs ${spec.clientId} and ${spec.clientSecret} first`);
  const redirect = spec.redirect ?? `http://127.0.0.1:${o.port ?? 9400}/oauth/callback`;
  const state = randomBytes(16).toString("hex");
  const listener = redirect.startsWith("http://")
    ? listen(redirect, state, o.timeoutMs ?? 300_000)
    : null;
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
  const landed = o
    .open({ url: url.toString(), ...(o.account ? { account: o.account } : {}) })
    .then((out) => {
      const at = (out as { landed?: unknown } | null)?.landed;
      return typeof at === "string" ? codeFrom(at, redirect, state) : null;
    });
  let code: string;
  try {
    const got = listener
      ? await Promise.race([listener.code, landed.then((c) => c ?? listener.code)])
      : await landed;
    if (!got) throw new Error(`consent: the flow did not land on ${redirect}`);
    code = got;
  } finally {
    listener?.close();
  }
  const client = clientFields(spec, id, secret);
  const body = await tokenCall(
    o.http,
    spec.tokenUrl,
    {
      grant_type: "authorization_code",
      code,
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
