/**
 * OAuth 2.0 the way a site API needs it: mint an access token from a
 * refresh token (code, no browser), and get that refresh token once by
 * driving the consent page in the site's logged-in profile with the
 * redirect caught on loopback. Tokens travel in bodies and headers only;
 * nothing here logs a value.
 */

import { randomBytes } from "node:crypto";
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
) {
  const res =
    method === "GET"
      ? await http.json<TokenBody>(`${url}?${form(fields)}`)
      : await http.json<TokenBody>(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          raw: form(fields),
        });
  if (!res.ok || !res.body?.access_token) {
    const why = res.body?.error ? `${res.body.error}: ${res.body.error_description ?? ""}` : "";
    throw new HttpError("POST", url, res.status, why.trim());
  }
  return res.body;
}

/**
 * An access token: minted from the refresh token when there is one (cached
 * until a minute before it expires), else the kept access token itself.
 */
export function accessTokens(
  http: HttpClient,
  env: (name: string) => string | undefined,
  now: () => number = Date.now,
): (spec: OAuthSpec) => Promise<string | null> {
  const cache = new Map<string, { token: string; until: number }>();
  return async (spec) => {
    const refresh = env(spec.refreshToken);
    const id = env(spec.clientId);
    const secret = env(spec.clientSecret);
    if (!refresh || !id || !secret) return (spec.accessToken && env(spec.accessToken)) || null;
    const hit = cache.get(spec.refreshToken);
    if (hit && hit.until > now()) return hit.token;
    const body = await tokenCall(http, spec.tokenUrl, {
      grant_type: "refresh_token",
      refresh_token: refresh,
      [spec.clientIdParam ?? "client_id"]: id,
      client_secret: secret,
    });
    const token = body.access_token as string;
    cache.set(spec.refreshToken, { token, until: now() + ((body.expires_in ?? 3600) - 60) * 1000 });
    return token;
  };
}

export interface ConsentInput {
  /** The authorize URL to open; the flow logs in and clicks allow. */
  url: string;
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
    /** Loopback port for the redirect; must match the client's registered redirect URI. */
    port?: number;
    timeoutMs?: number;
  },
): Promise<{ refreshToken: string | null; accessToken: string }> {
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
  for (const [k, v] of Object.entries({
    response_type: "code",
    [idParam]: id,
    redirect_uri: redirect,
    scope: spec.scopes.join(spec.scopeSeparator ?? " "),
    state,
    ...(spec.params ?? {}),
  }))
    url.searchParams.set(k, v);
  await Promise.all([o.open({ url: url.toString() }), code]);
  const body = await tokenCall(o.http, spec.tokenUrl, {
    grant_type: "authorization_code",
    code: await code,
    [idParam]: id,
    client_secret: secret,
    redirect_uri: redirect,
  });
  let accessToken = body.access_token as string;
  if (spec.longLived) {
    const long = await tokenCall(
      o.http,
      spec.longLived.url,
      { ...spec.longLived.fields, client_secret: secret, [spec.longLived.tokenParam]: accessToken },
      "GET",
    );
    accessToken = long.access_token as string;
  }
  return { refreshToken: body.refresh_token ?? null, accessToken };
}
