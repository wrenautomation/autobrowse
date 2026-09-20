/**
 * The facade over every site: match the official path, validate the
 * request as the official API would, answer through the API leg when a
 * token is in hand, else through the browser leg. Setup: which keys the
 * site still lacks and the step that makes each.
 */
import type { BrowserFlow, FlowRunner } from "../browser/flow.js";
import type { HttpClient } from "../clients/http.js";
import type { SecretSink } from "../deps/sink.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import type { Proof } from "../workflows/proof.js";
import { accessTokens, runConsent } from "./oauth.js";
import {
  type Leg,
  legName,
  type Method,
  type SetupStep,
  type SiteApi,
  SiteError,
  type SiteRoute,
} from "./types.js";

export interface SiteFacadeDeps {
  http: HttpClient;
  /** Where keys and tokens are read from (process.env on the box, the .env locally). */
  env: (name: string) => string | undefined;
  /** Where setup puts what it made. */
  sink: SecretSink;
  runner: FlowRunner;
  flow(name: string): BrowserFlow<never, unknown> | null;
  /** Compiled workflows by name, run in-process with gates approved (the caller gated the route). */
  compiled?: {
    get(name: string): Promise<AnyWorkflow | null>;
    run(workflow: AnyWorkflow, plan: Record<string, unknown>): Promise<CompiledRun>;
  };
  /** Loopback port for OAuth redirects. */
  oauthPort?: number;
  now?: () => number;
}

export type CompiledRun = Pick<Proof, "status" | "steps" | "output">;

export interface RouteRow {
  method: Method;
  path: string;
  summary: string;
  /** How it answers right now: the API, the browser, or nothing yet (`missing` says what). */
  via: "api" | "browser" | "none";
  missing?: string;
  irreversible: boolean;
}

export interface SetupRow extends Pick<SetupStep, "name" | "makes" | "needs" | "summary"> {
  done: boolean;
  /** Needs not yet present. */
  blockedOn: string[];
  /** The flow this step runs, when nobody has recorded it yet. */
  unrecorded?: string;
}

export interface SiteRow {
  site: string;
  origin: string;
  /** A bearer can be minted now. */
  authed: boolean;
  routes: RouteRow[];
  setup: SetupRow[];
}

export interface SiteFacade {
  list(): Promise<SiteRow[]>;
  status(site: string): Promise<SiteRow>;
  /** One call as the official API takes it: path params in the path, query for reads, body for writes. */
  call(
    site: string,
    method: Method,
    path: string,
    input: Record<string, unknown>,
  ): Promise<unknown>;
  /** Run one setup step; what it makes lands in the sink. */
  setup(site: string, step: string): Promise<{ made: readonly string[] }>;
}

/** `/rest/socialActions/{urn}/comments` against `/rest/socialActions/urn:li:share:1/comments`. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/");
  const a = path.split("?")[0]?.split("/") ?? [];
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i] as string;
    const got = a[i] as string;
    if (seg.startsWith("{") && seg.endsWith("}"))
      params[seg.slice(1, -1)] = decodeURIComponent(got);
    else if (seg !== got) return null;
  }
  return params;
}

export function siteFacade(sites: readonly SiteApi[], deps: SiteFacadeDeps): SiteFacade {
  const byName = new Map(sites.map((s) => [s.site, s]));
  const minted = accessTokens(deps.http, deps.env, deps.now);
  const site = (name: string) => {
    const s = byName.get(name);
    if (!s) throw new SiteError(404, `no site api named ${name}`);
    return s;
  };
  const tokenFor = async (s: SiteApi): Promise<string | null> =>
    "token" in s.auth ? (deps.env(s.auth.token) ?? null) : minted(s.auth.oauth);
  const hasToken = (s: SiteApi) => {
    if ("token" in s.auth) return Boolean(deps.env(s.auth.token));
    const o = s.auth.oauth;
    return Boolean(
      (deps.env(o.refreshToken) && deps.env(o.clientId) && deps.env(o.clientSecret)) ||
        (o.accessToken && deps.env(o.accessToken)),
    );
  };
  /** The browser leg's runnable, or null when nobody has recorded it yet. */
  const legOf = async (leg: Leg): Promise<((input: unknown) => Promise<unknown>) | null> => {
    if ("flow" in leg) {
      const flow = deps.flow(leg.flow);
      return flow ? (input) => deps.runner.run(flow as BrowserFlow<unknown, unknown>, input) : null;
    }
    const workflow = await deps.compiled?.get(leg.workflow);
    if (!workflow || !deps.compiled) return null;
    const { run } = deps.compiled;
    return async (input) => {
      const out = await run(workflow, (input ?? {}) as Record<string, unknown>);
      if (out.status !== "done") {
        const failed = out.steps.find((x) => x.status !== "done" && x.status !== "skipped");
        throw new SiteError(
          502,
          `${leg.workflow} ${out.status}${failed ? ` at ${failed.name}: ${failed.detail}` : ""}`,
        );
      }
      return out.output;
    };
  };
  const routeRow = async (s: SiteApi, r: SiteRoute<never, unknown>): Promise<RouteRow> => {
    const base = {
      method: r.method,
      path: r.path,
      summary: r.summary,
      irreversible: r.irreversible ?? false,
    };
    if (r.api && hasToken(s)) return { ...base, via: "api" };
    if (r.browser) {
      if (!(await legOf(r.browser)))
        return { ...base, via: "none", missing: `${legName(r.browser)} not recorded` };
      return { ...base, via: "browser" };
    }
    if (r.api) return { ...base, via: "none", missing: `no token for ${s.site}` };
    return { ...base, via: "none", missing: "no leg" };
  };
  const setupRow = async (step: SetupStep): Promise<SetupRow> => {
    const blockedOn = (step.needs ?? []).filter((n) => !deps.env(n));
    const row: SetupRow = {
      name: step.name,
      makes: step.makes,
      ...(step.needs ? { needs: step.needs } : {}),
      summary: step.summary,
      done: step.makes.every((n) => Boolean(deps.env(n))),
      blockedOn,
    };
    const how = step.how;
    const leg: Leg =
      "oauth" in how
        ? how.oauth.consent
        : "flow" in how
          ? { flow: how.flow }
          : { workflow: how.workflow };
    if (!(await legOf(leg))) row.unrecorded = legName(leg);
    return row;
  };
  const status = async (s: SiteApi): Promise<SiteRow> => ({
    site: s.site,
    origin: s.origin,
    authed: hasToken(s),
    routes: await Promise.all(s.routes.map((r) => routeRow(s, r))),
    setup: await Promise.all(s.setup.map(setupRow)),
  });
  return {
    list: () => Promise.all(sites.map(status)),
    status: (name) => status(site(name)),
    async call(name, method, path, input) {
      const s = site(name);
      let hit: { r: SiteRoute<never, unknown>; params: Record<string, string> } | null = null;
      for (const r of s.routes) {
        const params = r.method === method ? matchPath(r.path, path) : null;
        if (params) {
          hit = { r, params };
          break;
        }
      }
      if (!hit) throw new SiteError(404, `${method} ${path} is not a ${name} route`);
      const { r, params } = hit;
      const parsed = r.request.safeParse({ ...input, ...params });
      if (!parsed.success)
        throw new SiteError(400, parsed.error.issues.map((i) => i.message).join("; "));
      const token = r.api ? await tokenFor(s) : null;
      if (r.api && token) return r.api(parsed.data as never, { token, http: deps.http });
      if (r.browser) {
        const run = await legOf(r.browser);
        if (!run)
          throw new SiteError(
            501,
            `${method} ${r.path}: ${legName(r.browser)} not recorded yet; explore it`,
          );
        const input = r.browser.input ? r.browser.input(parsed.data as never) : parsed.data;
        const out = await run(input);
        return r.browser.output ? r.browser.output(out) : out;
      }
      throw new SiteError(501, `${method} ${r.path}: no token for ${name} and no browser leg`);
    },
    async setup(name, stepName) {
      const s = site(name);
      const step = s.setup.find((x) => x.name === stepName);
      if (!step) throw new SiteError(404, `no setup step ${stepName} on ${name}`);
      const blocked = (step.needs ?? []).filter((n) => !deps.env(n));
      if (blocked.length) throw new SiteError(409, `${stepName} needs ${blocked.join(", ")} first`);
      if (!("oauth" in step.how)) {
        const leg: Leg =
          "flow" in step.how ? { flow: step.how.flow } : { workflow: step.how.workflow };
        const run = await legOf(leg);
        if (!run) throw new SiteError(501, `${legName(leg)} not recorded yet; explore it`);
        // A hand-written flow keeps what it made through the sink it is handed; a compiled one has the worker's.
        const input: Record<string, unknown> = {
          ...(step.how.input ?? {}),
          ...("flow" in step.how ? { sink: deps.sink } : {}),
        };
        await run(input);
        return { made: step.makes };
      }
      const spec = step.how.oauth;
      const open = await legOf(spec.consent);
      if (!open) throw new SiteError(501, `${legName(spec.consent)} not recorded yet; explore it`);
      const got = await runConsent(spec, {
        http: deps.http,
        env: deps.env,
        open,
        ...(deps.oauthPort ? { port: deps.oauthPort } : {}),
      });
      const made: string[] = [];
      if (got.refreshToken) {
        await deps.sink.put(spec.refreshToken, got.refreshToken);
        made.push(spec.refreshToken);
      }
      if (spec.accessToken) {
        await deps.sink.put(spec.accessToken, got.accessToken);
        made.push(spec.accessToken);
      }
      if (!made.length)
        throw new SiteError(
          502,
          "consent gave no refresh token and the site keeps no access token",
        );
      return { made };
    },
  };
}
