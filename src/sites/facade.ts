/**
 * The facade over every site: match the official path, validate the
 * request as the official API would, answer through the API leg when a
 * token is in hand, else through the browser leg. Setup: which keys the
 * site still lacks and the step that makes each.
 *
 * Arming (wren designs/2026-10-12-push-everywhere.md): `arm` runs a browser leg's `prepare` (the
 * post open, the reply box found) in its own tab before anyone says yes, and answers an arm id.
 * The next call to the same path on the same browser runs the leg in that tab (or the call that
 * carries its id), so only the typing and the click remain.
 * An API leg, a spending route or a flow with no `prepare` arms nothing. An arm lapses after
 * `ARM_MS`; a lapsed or unknown id just runs the whole leg, so an arm is never trusted.
 */

import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import {
  currentCall,
  type DoneActs,
  markReached,
  markSubmitted,
  type Reach,
  withReach,
} from "../browser/attempt.js";
import { profileBusyOf } from "../browser/browsers.js";
import type { BrowserFlow, FlowRunner, HeldTab } from "../browser/flow.js";
import type { Render } from "../browser/render.js";
import { type AccessCode, AccessRefused, NeedsHuman } from "../browser/session.js";
import { type HttpClient, lastingRefusal } from "../clients/http.js";
import type { SecretSink } from "../deps/sink.js";
import { type JsonSchema, jsonSchemaOf } from "../engine/inputs.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import type { Approver } from "../gates/payment.js";
import { envSource, ringCount, type SpentKeys } from "../reach/key-ring.js";
import { type KeysDep, keyCall } from "../reach/key-source.js";
import type { Proof, RunAs } from "../workflows/proof.js";
import { type DailyCaps, type MeteredCall, RETRY_BUFFER } from "./caps.js";
import { type Effective, effective, type LimitStore, type SiteLimits } from "./limits.js";
import {
  accessTokens,
  accountEnv,
  type MintedTokens,
  pointedAt,
  pointTo,
  revokeGrant,
  runConsent,
  TokenRefused,
} from "./oauth.js";
import type { RefusedToken } from "./refused.js";
import type { UploadSessions } from "./uploads.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

import { runLeg } from "../engine/leg.js";
import type { RenewReport } from "./renew.js";
import {
  type ApiLeg,
  type Leg,
  legName,
  type Method,
  needsOf,
  type OAuthSpec,
  originOf,
  prefersBrowser,
  type SetupStep,
  type SiteApi,
  SiteError,
  type SiteRoute,
  siteEnv,
} from "./types.js";
import { withLocalFile } from "./upload-file.js";
import type { NoVerify, RouteVerify } from "./verdict.js";
import { tokenRefusal } from "./why.js";

const CODE_STATUS: Record<AccessCode, number> = {
  need_login: 401,
  platform_blocked: 403,
  rate_limited: 429,
  upstream_broken: 502,
};

/**
 * A browser leg's failure on a read, as a coded SiteError: a flow's `AccessRefused`, or a wall
 * the runner met (login → `need_login`, a captcha left → `platform_blocked`). Lasting, so terminal:
 * Restate would retry it for hours. Anything else stays as it was.
 */
export function accessError(err: unknown): SiteError | null {
  if (err instanceof AccessRefused)
    return new SiteError(CODE_STATUS[err.code], err.message, undefined, err.code);
  if (err instanceof NeedsHuman && err.wall) {
    const code = err.wall === "captcha" ? "platform_blocked" : "need_login";
    return new SiteError(CODE_STATUS[code], err.message, undefined, code);
  }
  return null;
}

export interface SiteFacadeDeps {
  http: HttpClient;
  /** Where keys and tokens are read from (process.env on the box, the .env locally). */
  env: (name: string) => string | undefined;
  /** Where setup puts what it made. */
  sink: SecretSink;
  /** Access tokens minted by any process on this machine, reused instead of minted again. */
  minted?: MintedTokens;
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
  /** The operator's limits over each site's `caps`, `accountCaps` and `pace` (`limits.json`); absent: the defaults. */
  limits?: LimitStore;
  /** Paid keys out of credit (`reach/key-ring.ts`), for `capsPerKey` and api legs that rotate keys. */
  spent?: SpentKeys;
  /** The vault's keys and their audit (`reach/key-source.ts`); absent, paid keys are the env names and no use is audited. */
  keys?: KeysDep;
  /** Resumable upload sessions by durable call, so a rerun call resumes its bytes. */
  uploads?: UploadSessions;
  /** A page in a stealth browser, for the fetch ladder's render and exit rungs (`browser/render.ts`). */
  render?: Render;
  /** Irreversible API calls already started, by durable call: a rerun of one is refused. */
  started?: DoneActs;
  /** How a paced call waits for its slot (tests pass a fake). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * The username behind a credential name the caller used for an account
   * (`linkedin@research`, or `linkedin` for the site's own): null when the
   * name is not one, and the account is taken as an address.
   */
  accountOf?: (site: string, name: string) => Promise<string | null>;
  /** An API leg answered with the token kept under `name`: a refusal of it is over. */
  worked?: (name: string) => void;
  /** The site's words when the value kept under `name` was refused; null when it may be called. */
  held?: (name: string) => string | null;
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
  /** Its tokens the platform refused, open incidents (`refused.ts`); absent when none are kept. */
  refused?: RefusedToken[];
}

/** Who is calling, for the caps ledger: `caller` as the caller names itself, `invocation` its Restate id. */
export interface CallFrom {
  caller?: string | null;
  invocation?: string;
  /** Run the browser leg up to its last safe step and answer `{armed}`; nothing is sent. */
  arm?: boolean;
  /** An earlier `arm`'s id: run the leg in its tab. Without it, the newest arm on the same path. */
  armId?: string;
}

/** What `arm` answers: an id for the call to carry, or null when there is nothing to warm. */
export interface Armed {
  armed: string | null;
  until?: string;
}

/** An armed tab lives this long; a profile holds at most `ARMS_PER_PROFILE` (the oldest goes). */
export const ARM_MS = 20 * 60_000;
/** The act a started irreversible API call is kept under. */
const STARTED = "api started";
/** How long a passed probe vouches for its bearer before a refusal asks it again. */
const PROBED_OK_MS = 10 * 60_000;
/** Why a rerun of a started publish is refused: a person checks the account, then sends again. */
export const MAY_HAVE_GONE =
  "an earlier try may have gone through before its answer was saved; check the account before sending again";
export const ARMS_PER_PROFILE = 3;

/** The words a call types: left out of the key an arm is matched by, since the yes may edit them. */
const TYPED = new Set(["text", "message", "body", "note", "comment"]);
/** One target per arm: `/2/tweets` replies to many posts, `{id}` tells them apart. */
const armKey = (input: unknown) =>
  JSON.stringify(input ?? null, (k, v) => (TYPED.has(k) ? undefined : v));

/** A browser leg's runnable: in the browser's page, or in an armed tab. */
type Runnable = ((input: unknown, on?: { page: Page }) => Promise<unknown>) & {
  flow?: BrowserFlow<unknown, unknown>;
};

export interface CapsReport {
  day: string;
  /** By `site|account|bucket`; today's only (a past day keeps its calls, not its counts). */
  used: Record<string, number>;
  /** Tries by the same key: `used` plus the failures that reached the site. */
  tried: Record<string, number>;
  calls: MeteredCall[];
}

/**
 * What a keyed write needs from its route to settle (`service.ts`, `send-journal.ts`): whether it
 * publishes, how a verify read proves it, and the id and link of what it made.
 */
export interface SendSpec {
  irreversible: boolean;
  /** Absent: the route declares nothing, so an unclear end stays `unknown`. */
  verify?: RouteVerify<unknown> | NoVerify;
  sentAs?: (output: unknown) => { id: string | null; url: string | null };
  /** The route's own input for this request: path params and query folded in, defaults applied. */
  parse(path: string, input: Record<string, unknown>): unknown;
}

export interface LimitsRow extends Effective {
  site: string;
  set: SiteLimits;
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
  /**
   * The route a write would hit, as a keyed call settles it. Throws `SiteError` 404 for a path
   * that is no route. Absent on a stand-in: the call then has no verify read.
   */
  sendSpec?(site: string, method: Method, path: string): SendSpec;
  /** A day's capped reads (today when absent): what each bucket used and every metered call, who asked. */
  caps(day?: string, site?: string): CapsReport;
  /** Each capped or paced site's limits now (`effective`), and what `limits.json` sets of them (`set`). */
  limits(site?: string): LimitsRow[];
  /** Change one site's limits in `limits.json` (`LimitStore.edit`); 404 for an unknown site. */
  editLimits(
    site: string,
    fn: (l: SiteLimits) => SiteLimits,
  ): { before: SiteLimits; after: SiteLimits; path: string };
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
  renew?(o?: { dry?: boolean; names?: readonly string[] }): Promise<RenewReport>;
  /**
   * End the grant behind a site's token at the site (`OAuthSpec.revoke`): the only way our code
   * revokes. Answers the kept names it covered, now dead; the caller makes them again.
   */
  revoke?(site: string, account?: string | null): Promise<{ revoked: string[] }>;
  /**
   * Open refused-token incidents, oldest first. Async like every other method: a facade behind
   * `holding` answers each call through a hold, so a sync answer would arrive as a Promise.
   */
  refused?(): Promise<RefusedToken[]>;
  /** Incidents no re-make was queued for yet, now marked queued: each one once. */
  claimRefused?(): Promise<RefusedToken[]>;
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
  const limitsOf = (s: SiteApi) => effective(s, deps.limits?.read() ?? {});
  const byName = new Map(sites.map((s) => [s.site, s]));
  // A site that rolls its refresh token on every mint (X) hands the new one to the sink.
  const minted = accessTokens(
    deps.http,
    deps.env,
    deps.now,
    (name, value) => deps.sink.put(name, value),
    deps.minted,
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
  /** The route that answers `method path` on a site, with the path's params. */
  const routeOf = (s: SiteApi, method: Method, path: string) => {
    for (const r of s.routes) {
      const params = r.method === method ? matchPath(r.path, path) : null;
      if (params) return { r, params };
    }
    throw new SiteError(404, `${method} ${path} is not a ${s.site} route`);
  };
  /** The path's own query is part of the request, as the official API reads it. */
  const requestOf = (
    r: SiteRoute<never, unknown>,
    path: string,
    params: Record<string, string>,
    input: Record<string, unknown>,
  ) => {
    const query = Object.fromEntries(new URLSearchParams(path.split("?")[1] ?? ""));
    const parsed = r.request.safeParse({ ...query, ...input, ...params });
    if (!parsed.success)
      throw new SiteError(400, parsed.error.issues.map((i) => i.message).join("; "));
    return parsed;
  };
  /** Kept names whose bearer the probe passed, till when: a scope 401 asks it once per window. */
  const probedOk = new Map<string, number>();
  /**
   * A refusal on `path` means a dead bearer: on the probe itself, or when the probe with the same
   * bearer is refused too. A probe that answers says the route refused, not the token.
   */
  const deadBearer = async (s: SiteApi, path: string, leg: ApiLeg, kept: string) => {
    if (!s.probe) return false;
    if (matchPath(path, s.probe.path)) return true;
    const now = (deps.now ?? Date.now)();
    if ((probedOk.get(kept) ?? 0) > now) return false;
    const { r, params } = routeOf(s, "GET", s.probe.path);
    if (!r.api) return false;
    const req = requestOf(r, s.probe.path, params, s.probe.input ?? {});
    try {
      await r.api(req.data as never, leg);
    } catch (e) {
      return tokenRefusal(e);
    }
    probedOk.set(kept, now + PROBED_OK_MS);
    return false;
  };
  const tokenFor = async (s: SiteApi, account?: string | null): Promise<string | null> =>
    "open" in s.auth
      ? ""
      : "token" in s.auth
        ? deps.env(accountEnv(s.auth.token, account)) || null
        : minted(s.auth.oauth, account);
  /** The kept name a call as `account` reads its token from (an alias's real copy); null for an open site. */
  const keptName = (s: SiteApi, account: string | null): string | null => {
    if ("open" in s.auth) return null;
    if ("token" in s.auth) return accountEnv(s.auth.token, account);
    const o = s.auth.oauth;
    const asked = accountEnv(o.refreshToken, account);
    const held = deps.env(asked);
    if (held) return pointedAt(held) ?? asked;
    return o.accessToken ? accountEnv(o.accessToken, account) : asked;
  };
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
  // What the account's token may do: the scopes its consent got (older tokens: the scopes their
  // consents ask), plus `<SITE>_GRANTS`, products and reviews passed, set by hand.
  const granted = (s: SiteApi, account: string | null): Set<string> => {
    const list = (v: string | undefined) => (v ?? "").split(/[\s,]+/).filter(Boolean);
    const got = deps.env(accountEnv(siteEnv(s.site, "SCOPES"), account));
    const asked = s.setup.flatMap((st) => ("oauth" in st.how ? st.how.oauth.scopes : []));
    return new Set([
      ...(got === undefined ? asked : list(got)),
      ...list(deps.env(siteEnv(s.site, "GRANTS"))),
    ]);
  };
  /** The grants this request's API leg needs and the account's token lacks. */
  const lacking = <I>(s: SiteApi, r: SiteRoute<I>, account: string | null, input?: I) => {
    const need = needsOf(r, input);
    if (!need.length) return [];
    const have = granted(s, account);
    return need.filter((g) => !have.has(g));
  };
  const arms = new Map<
    string,
    { route: string; profile: string; held: HeldTab; timer: ReturnType<typeof setTimeout> }
  >();
  const disarm = async (id: string) => {
    const a = arms.get(id);
    if (!a) return;
    arms.delete(id);
    clearTimeout(a.timer);
    await a.held.release();
  };
  /** Open a tab in the leg's browser and run its `prepare` there; null when it has none. */
  const armLeg = async (run: Runnable, input: unknown, route: string): Promise<Armed> => {
    const flow = run.flow;
    if (!flow?.prepare || flow.profile === "provider" || !deps.runner.tab) return { armed: null };
    const mine = [...arms].filter(([, a]) => a.profile === flow.site);
    for (const [id] of mine.slice(0, Math.max(0, mine.length - ARMS_PER_PROFILE + 1)))
      await disarm(id);
    const held = await deps.runner.tab(flow.site);
    const prepare = flow.prepare.bind(flow);
    try {
      await runLeg(
        deps.runner,
        { ...flow, name: `${flow.name}.prepare`, run: (fp, i) => prepare(fp, i) },
        input,
        { on: { page: held.page } },
      );
    } catch (err) {
      await held.release();
      throw err;
    }
    const id = randomUUID();
    const until = (deps.now ?? Date.now)() + ARM_MS;
    const timer = setTimeout(() => void disarm(id), ARM_MS);
    timer.unref?.();
    arms.set(id, { route, profile: flow.site, held, timer });
    return { armed: id, until: new Date(until).toISOString() };
  };
  /**
   * The armed tab for this path and browser, now the caller's: the one `id` names, or the newest
   * on the path. Null when lapsed or elsewhere.
   */
  const takeArm = (want: string | undefined, route: string, run: Runnable) => {
    const site = run.flow?.site;
    const id =
      want ?? [...arms].reverse().find(([, a]) => a.route === route && a.profile === site)?.[0];
    const a = id ? arms.get(id) : undefined;
    if (!a || !id || a.route !== route || a.profile !== site) return null;
    arms.delete(id);
    clearTimeout(a.timer);
    if (!a.held.page.isClosed()) return a.held;
    void a.held.release();
    return null;
  };
  /** The browser leg's runnable, or null when nobody has recorded it yet. */
  const legOf = async (
    leg: Leg,
    profile?: string | null,
    at?: string | null,
  ): Promise<Runnable | null> => {
    if ("flow" in leg) {
      const flow = deps.flow(leg.flow) as BrowserFlow<unknown, unknown> | null;
      if (!flow) return null;
      // Under another profile the same flow signs in as that account. The site's own login
      // runs where its credential's session lives: a provider's profile when it signs in through
      // the provider's button (William's LinkedIn, in `google`), as `browserFor` opens it.
      const sited = !profile
        ? flow
        : profile !== flow.site
          ? { ...flow, site: profile }
          : { ...flow, profile: flow.profile ?? ("provider" as const) };
      return Object.assign(
        (input: unknown, on?: { page: Page }) =>
          runLeg(deps.runner, sited, input, on ? { on } : {}),
        { flow: sited },
      );
    }
    const workflow = await deps.compiled?.get(leg.workflow);
    if (!workflow || !deps.compiled) return null;
    const { run } = deps.compiled;
    // Under another profile the workflow's flows at that provider sign in as that account.
    const as = profile && at && profile !== at ? { site: at, profile } : undefined;
    return async (input) => {
      // A recorded workflow marks no act as its send: once it runs, a failure may have gone through.
      markSubmitted();
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
    const lacks = lacking(s, r, account);
    if (r.api && !prefersBrowser(r) && hasToken(s, account) && !lacks.length)
      return { ...base, via: "api" };
    if (r.browser) {
      if (!recorded) return { ...base, via: "none", missing: `${legName(r.browser)} not recorded` };
      return { ...base, via: "browser" };
    }
    if (r.api && lacks.length)
      return { ...base, via: "none", missing: `waiting on ${lacks.join(", ")}` };
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
      origin: originOf(s, deps.env),
      authed: hasToken(s, as),
      routes: await Promise.all(s.routes.map((r) => routeRow(s, r, as))),
      setup: await Promise.all(s.setup.map(setupRow)),
      ...(s.probe ? { probe: s.probe } : {}),
    };
  };
  /** The chosen account's own caps (`SiteApi.accountCaps`), its credential names read as addresses. */
  const capsOfAccount = async (s: SiteApi, lim: Effective, chosen: string | null) => {
    if (!lim.accountCaps || !chosen) return {};
    const who = chosen.trim().toLowerCase();
    for (const [name, caps] of Object.entries(lim.accountCaps)) {
      const address = (await deps.accountOf?.(deps.providerOf?.(s) ?? s.site, name)) ?? name;
      if (address.trim().toLowerCase() === who) return caps;
    }
    return {};
  };
  /** `capsPerKey` buckets at their cap times the ring's live keys (one at least, so a missing key says so). */
  const capsOfKeys = async (
    s: SiteApi,
    lim: Effective,
    keyAccount: string | null,
  ): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const [bucket, base] of Object.entries(s.capsPerKey ?? {})) {
      const cap = lim.caps?.[bucket];
      if (cap === undefined || !deps.spent) continue;
      // A call that names its key counts on that key's own bucket: one key's cap.
      if (keyAccount) {
        out[bucket] = cap;
        continue;
      }
      const { live } = await ringCount(
        base,
        deps.keys?.source ?? envSource(async (n) => deps.env(n)),
        deps.spent,
        (deps.now ?? Date.now)(),
      );
      out[bucket] = cap * Math.max(1, live);
    }
    return out;
  };
  return {
    list: () => Promise.all(sites.map(status)),
    status: (name) => status(site(name)),
    limits(only) {
      const file = deps.limits?.read() ?? {};
      return sites
        .filter((s) => !only || s.site === only)
        .map((s) => ({ site: s.site, ...effective(s, file), set: file[s.site] ?? {} }))
        .filter((r) => r.caps || r.accountCaps || r.pace || r.retryBuffer !== undefined);
    },
    editLimits(name, fn) {
      site(name);
      if (!deps.limits) throw new SiteError(409, "no limits file here");
      return { ...deps.limits.edit(name, fn), path: deps.limits.path };
    },
    caps(day, only) {
      const today = new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10);
      const at = day ?? today;
      const caps = at === today ? deps.caps : undefined;
      const mine = (r: Record<string, number>) =>
        Object.fromEntries(Object.entries(r).filter(([k]) => !only || k.startsWith(`${only}|`)));
      return {
        day: at,
        used: mine(caps?.today() ?? {}),
        tried: mine(caps?.tried() ?? {}),
        calls: (deps.caps?.calls(at) ?? []).filter((c) => !only || c.site === only),
      };
    },
    sendSpec(name, method, path) {
      const { r, params } = routeOf(site(name), method, path);
      return {
        irreversible: r.irreversible ?? false,
        ...(r.verify ? { verify: r.verify as RouteVerify<unknown> | NoVerify } : {}),
        ...(r.sentAs ? { sentAs: r.sentAs as NonNullable<SendSpec["sentAs"]> } : {}),
        parse: (p, input): unknown => requestOf(r, p, params, input).data,
      };
    },
    async call(name, method, path, input, named, from) {
      const s = site(name);
      // A credential name (`linkedin@research`) is the account whose username it holds.
      const account = named
        ? ((await deps.accountOf?.(deps.providerOf?.(s) ?? s.site, named)) ?? named)
        : named;
      const { r, params } = routeOf(s, method, path);
      const parsed = requestOf(r, path, params, input);
      // Named by the caller, else by the accounts policy. A policy pick falls back to the site's own
      // token at a provider's site, and at a site whose key a browser flow mints (npm, Cal.com: one
      // key, kept under its plain name). A site with its own OAuth logins keeps that token for whoever
      // its own credential is (a person's own LinkedIn), never for the policy's account.
      const chosen = account ?? (s.signedOut ? null : await deps.accountFor?.(s)) ?? null;
      // An open site has no logins: what a caller names there is a key's address (`web` + `exa@label`).
      const keyAccount = "open" in s.auth && account ? account : null;
      const oneKey = !s.setup.some((st) => "oauth" in st.how);
      const fallback = !account && chosen && (deps.providerOf?.(s) || oneKey);
      // A route that prefers the browser never reaches the API, so never pays for a read; one
      // whose token lacks a grant (a review still pending) runs as if no token were held.
      const lacks = lacking(s, r, chosen, parsed.data as never);
      // Whose token the API leg holds: the chosen account's, else the site's own (`fallback`).
      let tokenAs = chosen;
      const tokenOf = (as: string | null) =>
        tokenFor(s, as).catch((e) => {
          // Which site and account asked, so the refusal is kept where `renew` finds it.
          if (e instanceof TokenRefused)
            throw new TokenRefused(e.token, e.why, { site: s.site, account: as });
          throw e;
        });
      let token: string | null = null;
      if (r.api && !prefersBrowser(r, parsed.data as never) && !lacks.length) {
        token = await tokenOf(chosen);
        if (token === null && fallback) {
          tokenAs = null;
          token = await tokenOf(null);
        }
      }
      const byBrowser = !(r.api && token !== null) && Boolean(r.browser);
      const use = r.meter?.(parsed.data as never);
      const lim = limitsOf(s);
      const note = (outcome: MeteredCall["outcome"], bucket?: string, spent?: boolean) => {
        if (!use || !lim.caps || !deps.caps) return;
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
          ...(spent !== undefined ? { spent } : {}),
        });
      };
      // Paced before counted: a refusal here spends none of the day's cap.
      const slot =
        byBrowser && lim.pace && deps.caps
          ? deps.caps.slot(s.site, chosen ?? s.site, lim.pace)
          : null;
      if (slot && !slot.ok) note("paced");
      if (slot && !slot.ok)
        throw new SiteError(
          429,
          `${s.site} pace for ${chosen ?? "the default account"}: too many calls queued; retry after ${slot.retryAfter}s`,
          slot.retryAfter,
        );
      let taken = false;
      if (use && lim.caps && deps.caps) {
        const limits = {
          ...lim.caps,
          ...(await capsOfKeys(s, lim, keyAccount)),
          ...(await capsOfAccount(s, lim, chosen)),
        };
        const buffer = lim.retryBuffer ?? (method === "GET" ? RETRY_BUFFER.read : RETRY_BUFFER.act);
        const t = deps.caps.take(s.site, chosen ?? s.site, use, limits, buffer);
        if (!t.ok) {
          note("capped", t.bucket);
          const who = chosen ?? "the default account";
          throw new SiteError(
            429,
            t.cap === 0
              ? `${s.site} ${t.bucket} reads are off for ${who} (cap 0)`
              : t.tries
                ? `${s.site} ${t.bucket} tries for ${who} are used (${t.used}/${t.cap} today, failures included); retry after ${t.retryAfter}s`
                : `${s.site} ${t.bucket} cap for ${who} is used (${t.used}/${t.cap} today); retry after ${t.retryAfter}s`,
            t.retryAfter,
          );
        }
        taken = true;
      }
      // What the call did at the site settles its slot: none, a try, or a use.
      const reach: Reach = { reached: false };
      try {
        const out = await withReach(reach, answer);
        note("ok");
        // The answer says the call used less (no invite offered): the day's count follows it.
        const real = taken && use && r.used?.(parsed.data as never, out as never);
        if (real && deps.caps) {
          const who = chosen ?? s.site;
          deps.caps.giveBack(s.site, who, use);
          deps.caps.take(s.site, who, real, {});
        } else if (taken && use && deps.caps && reach.already)
          // The thing was there (already following): the site saw a load, not the act.
          deps.caps.giveBack(s.site, chosen ?? s.site, use, true);
        return out;
      } catch (e) {
        // The profile was open elsewhere, the browser down, offline: nothing reached the site.
        const reached = reach.reached && !profileBusyOf(e);
        // Only a use that worked counts to the cap; a failure that reached the site is a try.
        if (taken && use) deps.caps?.giveBack(s.site, chosen ?? s.site, use, reached);
        if (profileBusyOf(e)) throw e;
        note("failed", undefined, reached);
        if (!use || !lim.caps || e instanceof SiteError || !reached) throw e;
        // A durable retry here would spend a try each time: a failure that reached the site ends
        // here and the caller chooses (six reads ate 40, 2026-10-01); the buffer holds its retries.
        // A platform's lasting refusal keeps its status (a 403 is a missing scope to the caller).
        const why = e instanceof Error ? e.message.slice(0, 300) : String(e);
        throw new SiteError(
          lastingRefusal(e) ? e.status : 502,
          `${s.site} ${method} ${r.path} failed after spending a try: ${why}`,
        );
      }
      async function answer(): Promise<unknown> {
        // Arming warms a browser leg; an API leg has nothing to warm, a spend is never pre-run.
        if (from?.arm && (!byBrowser || r.spends || method === "GET" || r.browser?.uploads))
          return { armed: null } satisfies Armed;
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
            url: `${originOf(s, deps.env)}${path}`,
            site: name,
            ...(amount ? { amount } : {}),
          });
          if (!ok) throw new SiteError(403, `${what}: refused`);
        }
        if (r.api && token !== null) {
          const kept = keptName(s, tokenAs);
          // A refused value: no call till a re-make (or a person) changes it.
          const held = kept ? deps.held?.(kept) : null;
          if (kept && held) throw new TokenRefused(kept, held, { site: s.site, account: tokenAs });
          // A rerun of a durable call (Restate after a crash or a redeploy mid-call) must not
          // publish twice: the first try may have gone through before its answer was saved.
          const call = currentCall();
          // A write's request is its submit step: a failure from here may have gone through.
          markReached();
          if (method !== "GET") markSubmitted();
          if (r.irreversible && !r.resumes && call && deps.started) {
            if (deps.started.has(call, STARTED))
              throw new SiteError(409, `${method} ${r.path}: ${MAY_HAVE_GONE}`);
            deps.started.add(call, STARTED);
          }
          const leg = (bearer: string): ApiLeg => ({
            token: bearer,
            http: deps.http,
            env: deps.env,
            keep: async (name, value) => deps.sink.put(name, value),
            ...(deps.spent ? { spent: deps.spent } : {}),
            ...(deps.keys
              ? {
                  keys: deps.keys.source,
                  keyCall: keyCall(deps.keys, {
                    by: from?.caller ?? "sites",
                    reason: `${method} ${r.path}`,
                    ...(keyAccount ? { account: keyAccount } : {}),
                  }),
                }
              : {}),
            ...(deps.uploads ? { uploads: deps.uploads } : {}),
            ...(deps.render ? { render: deps.render } : {}),
          });
          let out: unknown;
          try {
            out = await r.api(parsed.data as never, leg(token));
          } catch (e) {
            if (kept && tokenRefusal(e) && (await deadBearer(s, r.path, leg(token), kept)))
              throw new TokenRefused(kept, e.message, { site: s.site, account: tokenAs });
            throw e;
          }
          if (kept) deps.worked?.(kept);
          return out;
        }
        if (r.browser) {
          // The same account the API leg would have used: its profile, so a browser
          // leg posts as the site's own identity and never as whoever the default
          // profile happens to be signed in as.
          // A site with its own logins (LinkedIn) keeps the account in its own `site@label` profile.
          const at = deps.providerOf?.(s) ?? s.site;
          // A signed-out site borrowing another's flow (reddit-public runs reddit/read) stays in its
          // own profile, unless the leg says it needs the flow's signed-in one.
          const profile = chosen
            ? await deps.profileFor?.(at, chosen)
            : s.signedOut && !r.browser.signedIn
              ? s.site
              : null;
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
          const route = `${s.site} ${method} ${path} ${armKey(input)}`;
          if (from?.arm) return armLeg(run, input, route);
          const armed = takeArm(from?.armId, route, run);
          if (armed)
            try {
              const out = await run(input, { page: armed.page });
              return r.browser.output ? r.browser.output(out) : out;
            } finally {
              await armed.release();
            }
          const out = await (r.browser.uploads
            ? withLocalFile(input as Record<string, unknown>, r.browser.uploads, run)
            : run(input)
          ).catch((e: unknown) => {
            throw (method === "GET" && accessError(e)) || e;
          });
          return r.browser.output ? r.browser.output(out) : out;
        }
        if (lacks.length)
          throw new SiteError(
            501,
            `${method} ${r.path}: waiting on ${lacks.join(", ")} for ${name}, and no browser leg`,
          );
        throw new SiteError(501, `${method} ${r.path}: no token for ${name} and no browser leg`);
      }
    },
    async revoke(name, account) {
      const s = site(name);
      const spec = "oauth" in s.auth ? s.auth.oauth : null;
      if (!spec?.revoke) throw new SiteError(501, `${name} has no revoke endpoint`);
      // The same token a call would use: the named account's, else the policy's, else the site's own.
      const policy = account ?? (await deps.accountFor?.(s)) ?? null;
      const as =
        account ?? (policy && deps.env(accountEnv(spec.refreshToken, policy)) ? policy : null);
      const kept = keptName(s, as);
      if (!kept || !deps.env(kept))
        throw new SiteError(404, `no ${name} token kept${as ? ` for ${as}` : ""}`);
      const token =
        spec.revoke.token === "refresh"
          ? (deps.env(kept) as string)
          : await minted(spec, as).catch((e) => {
              if (e instanceof TokenRefused)
                throw new TokenRefused(e.token, e.why, { site: s.site, account: as });
              throw e;
            });
      if (!token) throw new SiteError(404, `no ${name} access token to revoke`);
      await revokeGrant(deps.http, spec, deps.env, token);
      return { revoked: [kept] };
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
      // What the token may do, so a route whose grant this consent added moves to the API.
      for (const as of names)
        await deps.sink.put(accountEnv(siteEnv(name, "SCOPES"), as), got.scopes.join(" "));
      return { made };
    },
  };
}
