/**
 * npm has two doors, and they do different jobs. The registry
 * (registry.npmjs.org) is a plain REST API: it makes accounts and answers
 * as a legacy token, and nothing about it is behind the bot check that
 * guards www.npmjs.com/signup. The website is where granular tokens are
 * minted — the only kind npm will keep honouring once tokens that bypass
 * 2FA are restricted (account changes Aug 2026, publishing Jan 2027).
 *
 * So: the account is made through the registry, the publish token through
 * the browser. Both end at the same place, `NPM_TOKEN` in the env store.
 */
import { z } from "zod";
import { type HttpClient, HttpError } from "../clients/http.js";
import { route, type SiteApi } from "./types.js";

export const NPM_REGISTRY = "https://registry.npmjs.org";
export const NPM_SITE = "https://www.npmjs.com";
export const NPM_TOKEN = "NPM_TOKEN";

export interface RegistryAccount {
  /** The npm username, which is not the email: lowercase, url-safe. */
  name: string;
  email: string;
  password: string;
}

export interface RegistryUser {
  /** The legacy token the registry answers with, when it does. */
  token: string | null;
  note: string;
}

/**
 * Make the account: `PUT /-/user/org.couchdb.user:<name>`, the call
 * `npm adduser` made before it moved to the website. A name already taken
 * answers 409, an address already registered 400 — both are the site
 * saying no, so they throw rather than read as success.
 */
export async function createRegistryUser(
  http: HttpClient,
  a: RegistryAccount,
): Promise<RegistryUser> {
  const path = `/-/user/org.couchdb.user:${encodeURIComponent(a.name)}`;
  const res = await http.json<{ ok?: boolean | string; token?: string; error?: string }>(
    `${NPM_REGISTRY}${path}`,
    {
      method: "PUT",
      body: {
        _id: `org.couchdb.user:${a.name}`,
        name: a.name,
        password: a.password,
        email: a.email,
        type: "user",
        roles: [],
        date: new Date().toISOString(),
      },
    },
  );
  // The error text is npm's own ("user already exists"); it carries no secret.
  if (!res.ok) throw new HttpError("PUT", `${NPM_REGISTRY}${path}`, res.status, res.body?.error);
  return { token: res.body?.token ?? null, note: String(res.body?.ok ?? "created") };
}

export const npm: SiteApi = {
  site: "npm",
  origin: NPM_REGISTRY,
  auth: { token: NPM_TOKEN },
  routes: [
    route({
      method: "GET",
      path: "/-/whoami",
      request: z.object({}),
      api: async (_i, leg) => {
        const res = await leg.http.json<{ username: string }>(`${NPM_REGISTRY}/-/whoami`, {
          headers: { authorization: `Bearer ${leg.token}` },
        });
        if (!res.ok) throw new HttpError("GET", `${NPM_REGISTRY}/-/whoami`, res.status);
        return res.body;
      },
      summary: "Who the stored token publishes as: the cheapest proof it is live",
    }),
  ],
  setup: [
    {
      name: "token",
      makes: [NPM_TOKEN],
      how: {
        flow: "npm/granular-token",
        input: { name: "autobrowse publish", access: "publish", bypass2fa: true, expiresDays: 90 },
      },
      summary:
        "Mint a 90-day granular token that publishes every package the account owns (2FA bypassed: the account has none) and keep it as NPM_TOKEN; rerun before it expires",
    },
  ],
};
