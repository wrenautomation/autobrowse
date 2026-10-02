/**
 * The facade over every site: match the official path, validate the
 * request as the official API would, answer through the API leg when a
 * token is in hand, else through the browser leg. Setup: which keys the
 * site still lacks and the step that makes each.
 */

import type { BrowserFlow, FlowRunner } from "../browser/flow.js";
import type { HttpClient } from "../clients/http.js";
import type { SecretSink } from "../deps/sink.js";
import { type JsonSchema, jsonSchemaOf } from "../engine/inputs.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import type { Approver } from "../gates/payment.js";
import type { Proof, RunAs } from "../workflows/proof.js";
import type { DailyCaps, MeteredCall } from "./caps.js";
import { accessTokens, accountEnv, pointTo, runConsent } from "./oauth.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

import type { RenewReport } from "./renew.js";
import {
  type Leg,
  legName,
  type Method,
  type OAuthSpec,
  type SetupStep,
  type SiteApi,
  SiteError,
  type SiteRoute,
} from "./types.js";
import { withLocalFile } from "./upload-file.js";

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
    run(workflow: AnyWorkflow, plan: Record<string, unknown>, as?: RunAs): Promise<CompiledRun>;
  };
  /** Loopback port for OAuth redirects. */
  oauthPort?: number;
  /**
   * The browser profile that holds an account of a site (`google@will` for
   * will@x.dev), so its consent runs signed in as it; the flow's own site
   * when absent (the chooser then picks).
   */
  profileFor?: (site: string, account: string) => Promise<string | null>;
  /**
   * The identity provider a site's accounts sign in at (`google` for a site
   * whose consent is Google's); null when its accounts are its own (LinkedIn).
   */
  providerOf?: (site: SiteApi) => string | null;
  /**
   * The account a call or setup step is for when the caller names none: the
   * person's account for the site's (or step's) purpose at the provider the
   * consent signs in with; null means the site's own token and profile.
   */
  accountFor?: (site: SiteApi, step?: SetupStep) => Promise<string | null>;
  now?: () => number;
  /**
   * Who says yes to a route that commits money (the spend policy, then the
   * person). Absent: every such call is refused, as the browser's gate is
   * without a channel.
   */
  approve?: Approver | null;
  /** Counts routes' `meter` against the site's `caps`, per account per day, and books `pace` slots; absent: nothing is capped. */
  caps?: DailyCaps;
  /** How a paced call waits for its slot (tests pass a fake). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * The username behind a credential name the caller used for an account
   * (`linkedin@research`, or `linkedin` for the site's own): null when the
   * name is not one, and the account is taken as an address.
   */
  accountOf?: (site: string, name: string) => Promise<string | null>;
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
  /** Can commit money: gated on the person before the API leg. */
  spends: boolean;
  /** What the request takes, as JSON Schema: body for writes, query + path params for reads. */
  request: JsonSchema;
}

export interface SetupRow extends Pick<SetupStep, "name" | "makes" | "needs" | "summary"> {
  done: boolean;
  /** Needs not yet present. */
  blockedOn: string[];
  /** The flow this step runs, when nobody has recorded it yet. */
  unrecorded?: string;
  /** What the step's flow is handed; `--input` overrides any key. */
  input?: Record<string, unknown>;
}

export interface SiteRow {
  site: string;
  origin: string;
  /** A bearer can be minted now. */
  authed: boolean;
  routes: RouteRow[];
  setup: SetupRow[];
  probe?: SiteApi["probe"];
}

/** Who is calling, for the caps ledger: `caller` as the caller names itself, `invocation` its Restate id. */
export interface CallFrom {
  caller?: string | null;
  invocation?: string;
}

export interface CapsReport {
  day: string;
  /** By `site|account|bucket`; today's only (a past day keeps its calls, not its counts). */
  used: Record<string, number>;
  calls: MeteredCall[];
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
    account?: string | null,
    from?: CallFrom,
  ): Promise<unknown>;
  /** A day's capped reads (today when absent): what each bucket used and every metered call, who asked. */
  caps(day?: string, site?: string): CapsReport;
  /** Run one setup step; what it makes lands in the sink (under the account's name, with one). */
  setup(
    site: string,
    step: string,
    account?: string | null,
    /** Force the browser profile the step runs in (a second profile for the same account). */
    profile?: string | null,
    /** Over the step's own input, key by key: a token's name, scopes, expiry for this run. */
    input?: Record<string, unknown>,
  ): Promise<{ made: readonly string[] }>;
  /**
   * Make again every kept token that lapses within the renew window, by the
   * setup step and account that made it; `dry` only says which. Absent when
   * nothing lists what is kept.
   */
  renew?(o?: { dry?: boolean }): Promise<RenewReport>;
}

export interface CheckRow {
  site: string;
  ok: boolean;
  ms?: number;
  /** Why not: no probe, no token, or the API's answer. */
  why?: string;
}

/** One who-am-I call on the API leg: proves the token works, not just that one is kept. */
export async function checkSite(
  f: Pick<SiteFacade, "call">,
  row: SiteRow,
  account: string | null = null,
  now: () => number = Date.now,
): Promise<CheckRow> {
  const probe = row.probe;
  if (!probe) return { site: row.site, ok: false, why: "no probe" };
  const r = row.routes.find((x) => x.method === "GET" && matchPath(x.path, probe.path));
  // The row's `via` is the site's plain token; an account's token is only found by calling as it.
  if (!account && r?.via !== "api")
    return { site: row.site, ok: false, why: r?.missing ?? "probe has no api leg" };
  const t = now();
  try {
    await f.call(row.site, "GET", probe.path, probe.input ?? {}, account);
    return { site: row.site, ok: true, ms: now() - t };
  } catch (e) {
    const status = e instanceof SiteError ? `${e.status} ` : "";
    const msg = e instanceof Error ? e.message : String(e);
    return {
      site: row.site,
      ok: false,
      ms: now() - t,
      why: `${status}${msg}`.replace(/\s+/g, " ").slice(0, 100),
    };
  }
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
    const m = /^([^{}]*)\{([^{}]+)\}([^{}]*)$/.exec(seg);
    if (m) {
      // `{urn}`, or a segment with a fixed prefix/suffix around it (`act_{adAccountId}`).
      const [, before = "", name = "", after = ""] = m;
      if (!got.startsWith(before) || !got.endsWith(after)) return null;
      const inner = got.slice(before.length, got.length - after.length);
      if (!inner) return null;
      params[name] = decodeURIComponent(inner);
    } else if (seg !== got) return null;
  }
  return params;
}

/** `{ env: "X" }` → the env store's value of X (its absence was caught by `needs`); anything else is itself. */
function resolveInput(v: unknown, env: SiteFacadeDeps["env"], account: string | null): unknown {
  if (
    v &&
    typeof v === "object" &&
    "account" in v &&
    (v as { account: unknown }).account === true
  ) {
    if (!account)
      throw new SiteError(
        409,
        "setup needs an account: --account <address>, or autobrowse accounts",
      );
    return account;
  }
  if (v && typeof v === "object" && "env" in v && typeof (v as { env: unknown }).env === "string") {
    const name = (v as { env: string }).env;
    const got = env(name);
    if (got === undefined) throw new SiteError(409, `setup needs ${name} first`);
    return got;
  }
  return v;
}

export function siteFacade(sites: readonly SiteApi[], deps: SiteFacadeDeps): SiteFacade {
  const byName = new Map(sites.map((s) => [s.site, s]));
  // A site that rolls its refresh token on every mint (X) hands the new one to the sink.
  const minted = accessTokens(deps.http, deps.env, deps.now, (name, value) =>
    deps.sink.put(name, value),
  );
  const identityOf = async (
    id: NonNullable<OAuthSpec["identity"]>,
    token: string,
  ): Promise<string | null> => {
    const res = await deps.http
      .json<Record<string, unknown>>(id.url, { headers: { authorization: `Bearer ${token}` } })
      .catch(() => null);
    // `emailAddress`, or a path into the answer (`data.username`).
    const v = res?.ok
      ? id.field.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], res.body)
      : null;
    return typeof v === "string" && v ? v.toLowerCase() : null;
  };
  const site = (name: string) => {
    const s = byName.get(name);
    if (!s) throw new SiteError(404, `no site api named ${name}`);
    return s;
  };
  const tokenFor = async (s: SiteApi, account?: string | null): Promise<string | null> =>
    "open" in s.auth
      ? ""
      : "token" in s.auth
        ? deps.env(accountEnv(s.auth.token, account)) || null
        : minted(s.auth.oauth, account);
  /** A token under the site's plain name, or under the account (the policy's when none is named). */
  const hasToken = (s: SiteApi, account: string | null = null) => {
    if ("open" in s.auth) return true;
    if ("token" in s.auth) return Boolean(deps.env(s.auth.token));
    const o = s.auth.oauth;
    const held = (as: string | null) =>
      Boolean(
        (deps.env(accountEnv(o.refreshToken, as)) &&
          deps.env(o.clientId) &&
          deps.env(o.clientSecret)) ||
          (o.accessToken && deps.env(accountEnv(o.accessToken, as))),
      );
    return held(null) || (account !== null && held(account));
  };
  /** The browser leg's runnable, or null when nobody has recorded it yet. */
  const legOf = async (
    leg: Leg,
    profile?: string | null,
    at?: string | null,
  ): Promise<((input: unknown) => Promise<unknown>) | null> => {
    if ("flow" in leg) {
      const flow = deps.flow(leg.flow) as BrowserFlow<unknown, unknown> | null;
      if (!flow) return null;
      // Under another profile the same flow signs in as that account.
      const sited = profile && profile !== flow.site ? { ...flow, site: profile } : flow;
      return (input) => deps.runner.run(sited, input);
    }
    const workflow = await deps.compiled?.get(leg.workflow);
    if (!workflow || !deps.compiled) return null;
    const { run } = deps.compiled;
    // Under another profile the workflow's flows at that provider sign in as that account.
    const as = profile && at && profile !== at ? { site: at, profile } : undefined;
    return async (input) => {
      const out = await run(workflow, (input ?? {}) as Record<string, unknown>, as);
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
  const routeRow = async (
    s: SiteApi,
    r: SiteRoute<never, unknown>,
    account: string | null,
  ): Promise<RouteRow> => {
    const base = {
      method: r.method,
      path: r.path,
      summary: r.summary,
      irreversible: r.irreversible ?? false,
      spends: Boolean(r.spends),
      request: jsonSchemaOf(r.request),
    };
    const recorded = r.browser ? Boolean(await legOf(r.browser)) : false;
    if (r.api && r.prefer !== "browser" && hasToken(s, account)) return { ...base, via: "api" };
    if (r.browser) {
      if (!recorded) return { ...base, via: "none", missing: `${legName(r.browser)} not recorded` };
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
      ...(!("oauth" in step.how) && step.how.input ? { input: step.how.input } : {}),
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
  const status = async (s: SiteApi): Promise<SiteRow> => {
    const as = s.signedOut ? null : ((await deps.accountFor?.(s)) ?? null);
    return {
      site: s.site,
      origin: s.origin,
      authed: hasToken(s, as),
      routes: await Promise.all(s.routes.map((r) => routeRow(s, r, as))),
      setup: await Promise.all(s.setup.map(setupRow)),
      ...(s.probe ? { probe: s.probe } : {}),
    };
  };
  /** The chosen account's own caps (`SiteApi.accountCaps`), its credential names read as addresses. */
  const capsOfAccount = async (s: SiteApi, chosen: string | null) => {
    if (!s.accountCaps || !chosen) return {};
    const who = chosen.trim().toLowerCase();
    for (const [name, caps] of Object.entries(s.accountCaps)) {
      const address = (await deps.accountOf?.(deps.providerOf?.(s) ?? s.site, name)) ?? name;
      if (address.trim().toLowerCase() === who) return caps;
    }
    return {};
  };
  return {
    list: () => Promise.all(sites.map(status)),
    status: (name) => status(site(name)),
    caps(day, only) {
      const today = new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10);
      const at = day ?? today;
      const used = at === today && deps.caps ? deps.caps.today() : {};
      return {
        day: at,
        used: Object.fromEntries(
          Object.entries(used).filter(([k]) => !only || k.startsWith(`${only}|`)),
        ),
        calls: (deps.caps?.calls(at) ?? []).filter((c) => !only || c.site === only),
      };
    },
    async call(name, method, path, input, named, from) {
      const s = site(name);
      // A credential name (`linkedin@research`) is the account whose username it holds.
      const account = named
        ? ((await deps.accountOf?.(deps.providerOf?.(s) ?? s.site, named)) ?? named)
        : named;
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
      // The path's own query is part of the request, as the official API reads it.
      const query = Object.fromEntries(new URLSearchParams(path.split("?")[1] ?? ""));
      const parsed = r.request.safeParse({ ...query, ...input, ...params });
      if (!parsed.success)
        throw new SiteError(400, parsed.error.issues.map((i) => i.message).join("; "));
      // Named by the caller, else by the accounts policy. A policy pick falls back to the site's own
      // token at a provider's site, and at a site whose key a browser flow mints (npm, Cal.com: one
      // key, kept under its plain name). A site with its own OAuth logins keeps that token for whoever
      // its own credential is (a person's own LinkedIn), never for the policy's account.
      const chosen = account ?? (s.signedOut ? null : await deps.accountFor?.(s)) ?? null;
      const oneKey = !s.setup.some((st) => "oauth" in st.how);
      const fallback = !account && chosen && (deps.providerOf?.(s) || oneKey);
      // A route that prefers the browser never reaches the API, so never pays for a read.
      const token =
        r.api && r.prefer !== "browser"
          ? ((await tokenFor(s, chosen)) ?? (fallback ? await tokenFor(s, null) : null))
          : null;
      const byBrowser = !(r.api && token !== null) && Boolean(r.browser);
      const use = r.meter?.(parsed.data as never);
      const note = (outcome: MeteredCall["outcome"], bucket?: string) => {
        if (!use || !s.caps || !deps.caps) return;
        deps.caps.note({
          at: new Date((deps.now ?? Date.now)()).toISOString(),
          site: s.site,
          account: chosen ?? s.site,
          route: `${method} ${r.path}`,
          use,
          caller: from?.caller ?? null,
          ...(from?.invocation ? { invocation: from.invocation } : {}),
          outcome,
          ...(bucket ? { bucket } : {}),
        });
      };
      // Paced before counted: a refusal here spends none of the day's cap.
      const slot =
        byBrowser && s.pace && deps.caps ? deps.caps.slot(s.site, chosen ?? s.site, s.pace) : null;
      if (slot && !slot.ok) note("paced");
      if (slot && !slot.ok)
        throw new SiteError(
          429,
          `${s.site} pace for ${chosen ?? "the default account"}: too many calls queued; retry after ${slot.retryAfter}s`,
          slot.retryAfter,
        );
      if (use && s.caps && deps.caps) {
        const limits = { ...s.caps, ...(await capsOfAccount(s, chosen)) };
        const t = deps.caps.take(s.site, chosen ?? s.site, use, limits);
        if (!t.ok) {
          note("capped", t.bucket);
          const who = chosen ?? "the default account";
          throw new SiteError(
            429,
            t.cap === 0
              ? `${s.site} ${t.bucket} reads are off for ${who} (cap 0)`
              : `${s.site} ${t.bucket} cap for ${who} is used (${t.used}/${t.cap} today); retry after ${t.retryAfter}s`,
            t.retryAfter,
          );
        }
      }
      try {
        const out = await answer();
        note("ok");
        return out;
      } catch (e) {
        note("failed");
        if (!use || !s.caps || e instanceof SiteError) throw e;
        // The slot is spent whatever broke: a durable retry would spend one per try, so
        // a failed metered read ends here and the caller chooses (six reads ate 40, 2026-10-01).
        const why = e instanceof Error ? e.message.slice(0, 200) : String(e);
        throw new SiteError(
          502,
          `${s.site} ${method} ${r.path} failed after spending a read: ${why}`,
        );
      }
      async function answer(): Promise<unknown> {
        const amount = r.spends ? r.spends(parsed.data as never) : false;
        if (amount !== false) {
          const what = `${method} ${path} on ${name}, which spends`;
          if (!deps.approve)
            throw new SiteError(
              403,
              `${what}: no channel to ask on (set PHONE_NUMBER, LINQ_* or NOTIFY_TO)`,
            );
          const ok = await deps.approve({
            what,
            url: `${s.origin}${path}`,
            site: name,
            ...(amount ? { amount } : {}),
          });
          if (!ok) throw new SiteError(403, `${what}: refused`);
        }
        if (r.api && token !== null)
          return r.api(parsed.data as never, {
            token,
            http: deps.http,
            env: deps.env,
            keep: async (name, value) => deps.sink.put(name, value),
          });
        if (r.browser) {
          // The same account the API leg would have used: its profile, so a browser
          // leg posts as the site's own identity and never as whoever the default
          // profile happens to be signed in as.
          // A site with its own logins (LinkedIn) keeps the account in its own `site@label` profile.
          const at = deps.providerOf?.(s) ?? s.site;
          const profile = chosen ? await deps.profileFor?.(at, chosen) : null;
          if (chosen && at === s.site && deps.profileFor && !profile)
            throw new SiteError(
              409,
              `${method} ${r.path}: no ${s.site} profile signs in as the chosen account (autobrowse accounts); creds paste ${s.site}@<label> with its username`,
            );
          const run = await legOf(r.browser, profile, at);
          if (!run)
            throw new SiteError(
              501,
              `${method} ${r.path}: ${legName(r.browser)} not recorded yet; explore it`,
            );
          if (slot?.waitMs) await (deps.sleep ?? sleep)(slot.waitMs);
          const input = r.browser.input
            ? r.browser.input(parsed.data as never, deps.env)
            : parsed.data;
          const out = r.browser.uploads
            ? await withLocalFile(input as Record<string, unknown>, r.browser.uploads, run)
            : await run(input);
          return r.browser.output ? r.browser.output(out) : out;
        }
        throw new SiteError(501, `${method} ${r.path}: no token for ${name} and no browser leg`);
      }
    },
    async setup(name, stepName, account, asProfile, over) {
      const s = site(name);
      const step = s.setup.find((x) => x.name === stepName);
      if (!step) throw new SiteError(404, `no setup step ${stepName} on ${name}`);
      const blocked = (step.needs ?? []).filter((n) => !deps.env(n));
      if (blocked.length) throw new SiteError(409, `${stepName} needs ${blocked.join(", ")} first`);
      if (!("oauth" in step.how)) {
        const leg: Leg =
          "flow" in step.how ? { flow: step.how.flow } : { workflow: step.how.workflow };
        // The account the step runs as: the caller's, else the policy's for its purpose; its
        // profile re-sites the leg's flows at the provider so they sign in as it.
        const as = account ?? (await deps.accountFor?.(s, step)) ?? null;
        const at = deps.providerOf?.(s) ?? null;
        const profile = asProfile ?? (as && at ? await deps.profileFor?.(at, as) : null);
        const run = await legOf(leg, profile, at);
        if (!run) throw new SiteError(501, `${legName(leg)} not recorded yet; explore it`);
        // A hand-written flow keeps what it made through the sink it is handed; a compiled one has the worker's.
        const input: Record<string, unknown> = {
          ...Object.fromEntries(
            Object.entries(step.how.input ?? {}).map(([k, v]) => [
              k,
              resolveInput(v, deps.env, as),
            ]),
          ),
          ...over,
          ...("flow" in step.how ? { sink: deps.sink } : {}),
        };
        await run(input);
        return { made: step.makes };
      }
      if (over && Object.keys(over).length)
        throw new SiteError(400, `${stepName} is an OAuth consent; it takes no input`);
      const spec = step.how.oauth;
      const implicit = !account ? ((await deps.accountFor?.(s, step)) ?? null) : null;
      const as = account ?? implicit;
      // A site made through a provider (TikTok via Google) consents in that account's
      // provider profile, where its browser legs run too.
      const at =
        deps.providerOf?.(s) ??
        ("flow" in spec.consent ? (spec.consent.flow.split("/")[0] ?? name) : null);
      const profile = asProfile ?? (as && at ? await deps.profileFor?.(at, as) : null);
      // A named account with no credential of its own would consent in the default profile,
      // as whoever that is (a person's own account, once): refuse instead.
      if (as && at && !profile && deps.profileFor)
        throw new SiteError(
          409,
          `no ${at} credential for ${as}: store one first (creds set ${at}@<label>)`,
        );
      const open = await legOf(spec.consent, profile);
      if (!open) throw new SiteError(501, `${legName(spec.consent)} not recorded yet; explore it`);
      const got = await runConsent(spec, {
        http: deps.http,
        env: deps.env,
        open,
        account: as,
        ...(deps.oauthPort ? { port: deps.oauthPort } : {}),
      });
      const made: string[] = [];
      // Kept with its lapse date, so `renew` consents again before it stops working.
      const expiresAt = got.expiresIn
        ? { expiresAt: new Date((deps.now?.() ?? Date.now()) + got.expiresIn * 1000).toISOString() }
        : {};
      // Under the account's name too when the site says who consented (and it is not the one asked
      // for); under the site's own name as well when the policy, not the caller, picked the account.
      const who = spec.identity ? await identityOf(spec.identity, got.accessToken) : null;
      const names = [...(implicit ? [null] : []), as, ...(who && who !== as ? [who] : [])];
      for (const as of names) {
        if (got.refreshToken) {
          const at = accountEnv(spec.refreshToken, as);
          // One real copy; every other name points at it. A site that rolls the refresh
          // token on each use (X) would leave a second copy dead after the first mint.
          const real = accountEnv(spec.refreshToken, names[0] ?? null);
          await deps.sink.put(at, at === real ? got.refreshToken : pointTo(real));
          made.push(at);
        }
        // The access token itself only when nothing mints one (no refresh token came back).
        if (spec.accessToken && !got.refreshToken) {
          const at = accountEnv(spec.accessToken, as);
          await deps.sink.put(at, got.accessToken, expiresAt);
          made.push(at);
        }
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
