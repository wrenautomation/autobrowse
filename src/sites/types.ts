/**
 * Site APIs: autobrowse exposes a service under the shape of its official
 * REST API (`POST /api/sites/linkedin/rest/posts` takes what LinkedIn's
 * Posts API takes and answers what it answers). Behind one route the
 * official API answers when a token is in hand; a browser flow answers
 * otherwise (the API is partner-gated, or there is none). The caller has
 * one client either way. The same module says how the site's keys and
 * tokens get made: setup steps that are browser flows (developer app,
 * OAuth client) and OAuth consents autobrowse drives itself.
 */
import type { z } from "zod";
import type { HttpClient } from "../clients/http.js";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** What a route's `api` leg is handed: the bearer for this site, the HTTP door. */
export interface ApiLeg {
  token: string;
  http: HttpClient;
}

/**
 * A route's browser leg: a hand-written flow by `site/name`, or a compiled
 * workflow by name (what a recording becomes), and how the request and the
 * answer map onto it.
 */
export type BrowserLeg<I, O> = Leg & {
  /** The flow's input (or the workflow's plan) from the request; the request itself when absent. */
  input?: (i: I) => unknown;
  /** The official response shape from what the leg read; the output itself when absent. */
  output?: (o: unknown) => O;
};

/** A hand-written flow by `site/name`, or a compiled workflow by name (what a recording becomes). */
export type Leg = { flow: string } | { workflow: string };
export const legName = (leg: Leg): string =>
  "flow" in leg ? `flow ${leg.flow}` : `workflow ${leg.workflow}`;

export interface SiteRoute<I = unknown, O = unknown> {
  method: Method;
  /** The official path, `{param}` for a path segment: `/rest/socialActions/{urn}/comments`. */
  path: string;
  /** Validates the request the way the official API takes it: body for writes, query + path params for reads. */
  request: z.ZodType<I>;
  /** The official API's leg; absent when the API has no such call. */
  api?: (input: I, leg: ApiLeg) => Promise<O>;
  /** The browser leg; absent when the API always answers. */
  browser?: BrowserLeg<I, O>;
  /** Publishes something: said in the route listing so an orchestrator gates it. */
  irreversible?: boolean;
  summary: string;
}

/** One key or token the site needs, and what makes it. */
/** A literal, or the value of an env name (one an earlier setup step made, or the person set). */
export type SetupInput = unknown | { env: string };

export interface SetupStep {
  name: string;
  /** Env names this step produces. */
  makes: readonly string[];
  /** Env names it needs first. */
  needs?: readonly string[];
  /**
   * A browser leg on the developer console (its input is the flow's input or the
   * workflow's plan; a `{ env }` value is read from the env store at run time, so a
   * step can take what an earlier step made), or an OAuth consent autobrowse drives.
   */
  how: (Leg & { input?: Record<string, SetupInput> }) | { oauth: OAuthSpec };
  summary: string;
}

export interface OAuthSpec {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: readonly string[];
  /** Env names of the client id and secret this consent uses. */
  clientId: string;
  clientSecret: string;
  /** Extra query on the authorize URL (`access_type=offline`, `prompt=consent`). */
  params?: Record<string, string>;
  /** The query/form name the client id travels as; TikTok says `client_key`. */
  clientIdParam?: string;
  /** Between scopes on the authorize URL: a space unless the site wants commas (TikTok, Meta). */
  scopeSeparator?: string;
  /**
   * A second call that trades the short-lived token the code exchange gave for a
   * long one (Instagram: 60 days). GET `url` with `fields`, the client secret, and
   * the short token as `tokenParam`; what it answers is the access token kept.
   */
  longLived?: { url: string; fields: Record<string, string>; tokenParam: string };
  /** Env name the refresh token is kept as; the access token is minted from it on demand. */
  refreshToken: string;
  /**
   * Who consented: GET `url` with the new token, read `field` (an address, a
   * handle). The tokens are then also kept under that account's name, so a
   * consent without `--account` still serves calls made as that identity.
   */
  identity?: { url: string; field: string };
  /**
   * Env name the access token itself is kept as, for a site that hands no refresh
   * token (LinkedIn without programmatic refresh: 60-day tokens; consent again).
   */
  accessToken?: string;
  /** The leg that opens the authorize URL (`{url}`) in the site's logged-in profile and clicks through. */
  consent: Leg;
}

export interface SiteApi {
  site: string;
  /** The official API's origin, for the api legs: `https://api.linkedin.com`. */
  origin: string;
  /** Env name of the bearer, or an OAuth spec to mint one from a refresh token. */
  auth: { token: string } | { oauth: OAuthSpec };
  routes: readonly SiteRoute<never, unknown>[];
  setup: readonly SetupStep[];
}

export class SiteError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SiteError";
    this.status = status;
  }
}

/** Define a route with its input type inferred from the schema. */
export function route<I, O>(r: SiteRoute<I, O>): SiteRoute<never, unknown> {
  return r as unknown as SiteRoute<never, unknown>;
}
