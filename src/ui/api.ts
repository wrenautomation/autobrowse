/**
 * The HTTP face of a worker: runs, gates, live events, recordings,
 * compile, and an inbound hook that takes what a person typed on any
 * channel. Thin on purpose: every mutation is one Restate call, every
 * body is validated, and every file served is checked to live under the
 * directory it claims. Reads are open when no token is set (local use);
 * with a token, everything needs it.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { refusal } from "../access/fence.js";
import { allowsSite, allowsWorkflow, type KeyStore, type Scope, seesSite } from "../access/keys.js";
import { proposeWorkflows, readFailures } from "../agent/evaluator.js";
import { readFailure, repairRequest } from "../agent/repair.js";
import { AGENT, summarizeSession } from "../agent/sessions.js";
import { type Backend, proofsOf, workflowsOf } from "../app/backend.js";
import { accountEdit } from "../auth/accounts.js";
import type { FailureRecord } from "../browser/session.js";
import { parseCommand } from "../channels/commands.js";
import { HttpError } from "../clients/http.js";
import {
  type LinqClient,
  type LinqEvent,
  linqEvent,
  textOf,
  verifyLinqWebhook,
} from "../clients/linq.js";
import { outlineSchema } from "../compiler/index.js";
import { DoError } from "../do/doer.js";
import type { GateName } from "../engine/effects.js";
import type { RunEvent } from "../engine/events.js";
import { jsonSchemaOf } from "../engine/inputs.js";
import type { RunRow } from "../engine/registry.js";
import { cursorOf, LIST_LIMIT, type ListQuery, ROW_STATUSES } from "../engine/rows.js";
import { commandSchema } from "../explore/server.js";
import { listRecordingSummaries, loadRecording, recordingDir } from "../recorder/store.js";
import { type Method, SiteError } from "../sites/index.js";
import { needAffordances, runAffordances, setupAffordances } from "./affordances.js";
import { accessAuth, bearerAuth, originGuard, rateLimit } from "./auth.js";
import { csvOf, errorBody, fail, limitParam, page, readJson, readPath, readQuery } from "./http.js";
import { Jobs, type JobView } from "./jobs.js";

/** The HTTP face: the shared `Backend` port plus what only this transport needs. */
export interface ApiDeps extends Backend {
  token: string | undefined;
  /** Agent keys: each sees and calls only its scope (`access/keys`). */
  keys?: KeyStore | null;
  /** Linq: replies to the operator's iMessages; `secret` verifies the webhook. */
  linq?: { client: LinqClient; to: string; secret?: string };
  /** Called on every request that changes something: a person is here (the idle stop listens). Reads never count. */
  touch?: () => void;
  /** Requests a minute per caller (an agent key, or the operator); defaults in `LIMITS`. */
  limits?: Partial<typeof LIMITS>;
}

/**
 * Per caller a minute. Reads are cheap and the pages poll; writes start
 * browsers and spend site caps. A body is JSON and small: an outline, a plan.
 */
export const LIMITS = { reads: 600, writes: 120, hooks: 60, bodyBytes: 1_000_000 };

/**
 * A site error keeps its status (404 route, 400 request, 501 no leg, 409
 * blocked, 429 cap). The site's own HTTP error is `upstream_error` with
 * `upstreamStatus`: its 4xx stays (a 404 there is a 404 here), except
 * 401/403, which become 502 so they never read as this API refusing the
 * caller's key; its 5xx and network failures are 502.
 */
function siteError(c: Context, err: unknown) {
  if (err instanceof SiteError) {
    if (err.retryAfter !== undefined) c.header("Retry-After", String(err.retryAfter));
    return fail(c, err.status, err.message, {
      ...(err.status === 404 ? { code: "not_found" as const } : {}),
      ...(err.retryAfter !== undefined ? { retryAfter: err.retryAfter } : {}),
    });
  }
  if (err instanceof HttpError) {
    const up = err.status || 0;
    const status = up >= 400 && up < 500 && up !== 401 && up !== 403 ? up : 502;
    return fail(c, status, err.message, { code: "upstream_error", upstreamStatus: up || null });
  }
  throw err;
}

/** A site or `site@account`, as the credential store names them. */
const SITE = /^[a-z][a-z0-9-]*(@[a-z0-9][a-z0-9.@_-]*)?$/i;

/** What a client may change while the worker runs; each applies to whatever opens next. */
const liveSettings = z.object({ headless: z.boolean() });
export type LiveSettings = z.infer<typeof liveSettings>;
const settingsView = (deps: ApiDeps): LiveSettings => ({ headless: deps.screen.headless });

const agentStart = z.object({
  site: z.string().regex(SITE),
  goal: z.string().min(1).max(2000),
  inputs: z.record(z.string(), z.string()).optional(),
  maxSteps: z.number().int().min(1).max(200).optional(),
  url: z.string().url().optional(),
});
const AGENT_ACTIONS = ["pause", "resume", "stop", "save", "close"] as const;
const agentAction = z.object({ name: z.string().optional() });
const repairBody = z.object({ failure: z.string().min(1), goal: z.string().max(2000).optional() });

const ACTIONS = ["approve", "reject", "pause", "play", "reset"] as const;
type Action = (typeof ACTIONS)[number];
const isAction = (s: string): s is Action => (ACTIONS as readonly string[]).includes(s);
const actionBody = z.object({
  name: z.enum(["purchase", "password", "send", "choose", "human"]).optional(),
  note: z.string().max(2000).optional(),
});
const inboundBody = z.object({ text: z.string().min(1).max(2000), from: z.string().optional() });
const NAME = /^[a-z][a-z0-9-]*$/;
const KEY = /^[a-z0-9][a-z0-9.@_-]*$/i;
const siteParam = z.object({
  site: z.string().regex(SITE, "a site: lowercase, dashes, optional @account"),
});
const runParams = z.object({
  workflow: z.string().regex(NAME, "a workflow name: lowercase, dashes"),
  key: z.string().regex(KEY, "a run key: letters, digits, . @ _ -"),
});
const recordingParam = z.object({
  name: z.string().regex(NAME, "a recording name: lowercase, dashes"),
});
const runsQuery = z.object({
  // Under the registry's own cap (1000), so the one extra row asked for still comes back.
  limit: limitParam(LIST_LIMIT, 500),
  before: z.string().min(1).optional(),
  status: csvOf(ROW_STATUSES).optional(),
  workflow: z.string().regex(NAME).optional(),
});
const JOB_STATUSES = ["running", "done", "failed"] as const;
const jobsQuery = z.object({
  limit: limitParam(100, 100),
  status: csvOf(JOB_STATUSES).optional(),
  kind: z.string().min(1).optional(),
});
const jobQuery = z.object({ wait: z.coerce.number().int().min(0).max(30_000).default(0) });
const recordingsQuery = z.object({
  limit: limitParam(100, 1_000),
  before: z.string().min(1).optional(),
  site: z.string().regex(SITE).optional(),
});
const eventsQuery = z.object({ after: z.coerce.number().int().min(0).default(0) });
const ledgerQuery = z.object({
  since: z
    .string()
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
});

const MIME: Record<string, string> = {
  png: "image/png",
  zip: "application/zip",
  log: "text/plain",
  json: "application/json",
};

/** A file response only when `file` resolves inside `root`. */
function serveUnder(root: string, file: string): Response | null {
  const base = resolve(root);
  const full = resolve(root, file);
  if (full !== base && !full.startsWith(base + sep)) return null;
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  const ext = full.split(".").pop() ?? "";
  return new Response(Readable.toWeb(createReadStream(full)) as ReadableStream, {
    headers: {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": "private, max-age=3600",
    },
  });
}

/** The newest row matching, paging back through the registry: a run waiting for days sits under newer ones. */
export async function findRow(
  registry: { list(q: ListQuery): PromiseLike<RunRow[]> },
  match: (r: RunRow) => boolean,
  maxPages = 10,
  /** Narrows each page in the registry, so the pages walked hold only candidates. */
  filter: Pick<ListQuery, "status" | "workflow"> = {},
): Promise<RunRow | undefined> {
  let before: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const rows = await registry.list({ ...filter, ...(before ? { before } : {}) });
    const hit = rows.find(match);
    if (hit) return hit;
    const last = rows.at(-1);
    if (rows.length < LIST_LIMIT || !last) return undefined;
    before = cursorOf(last);
  }
  return undefined;
}

type Env = { Variables: { scope: Scope } };

export function api(deps: ApiDeps): Hono<Env> {
  const app = new Hono<Env>();
  const workflows = () => workflowsOf(deps);
  const proofs = () => proofsOf(deps);
  const find = async (name: string) => (await workflows()).find((w) => w.name === name) ?? null;
  const runOf = (workflow: string, key: string) => deps.ingress.run(workflow, key);

  const limits = { ...LIMITS, ...deps.limits };
  // Anything unmatched or thrown answers in the same shape as every refusal; a stack never leaves.
  app.notFound((c) => fail(c, 404, `no route ${c.req.method} ${c.req.path}`));
  app.onError((err, c) => {
    console.error(`[api] ${c.req.method} ${c.req.path}:`, err);
    return c.json(errorBody(500, "internal error: see the worker log"), 500);
  });
  const tooBig = bodyLimit({
    maxSize: limits.bodyBytes,
    onError: (c) => fail(c, 413, `body over ${limits.bodyBytes} bytes`),
  });
  app.use("/api/*", tooBig);
  app.use("/hooks/*", tooBig);
  app.use("/api/*", originGuard(deps.token));
  app.use("/api/*", accessAuth(deps.token, deps.keys));
  // Counted per caller once it is known: each agent key has its own minute, the operator one.
  const callerOf = (c: Context) => (c as Context<Env>).get("scope")?.name ?? "anonymous";
  const readLimit = rateLimit({ perMinute: limits.reads, keyOf: callerOf });
  const writeLimit = rateLimit({ perMinute: limits.writes, keyOf: callerOf });
  app.use("/api/*", (c, next) =>
    c.req.method === "GET" || c.req.method === "HEAD" ? readLimit(c, next) : writeLimit(c, next),
  );
  // An agent key gets in only where its scope says (`access/fence`).
  app.use("/api/*", async (c, next) => {
    const why = refusal(c.get("scope"), c.req.method, c.req.path, c.req.query(), {
      sessionSite: (id) => deps.agent?.get(id)?.site ?? null,
    });
    if (why) return fail(c, 403, why);
    await next();
  });
  const scopeOf = (c: Context<Env>) => c.get("scope");
  /** A run row or event an agent may see: its workflow, or its session's site. */
  const visibleRun = (scope: Scope, workflow: string, key: string) => {
    if (scope.operator) return true;
    const session = workflow === AGENT ? deps.agent?.get(key) : null;
    return session ? allowsSite(scope, session.site) : allowsWorkflow(scope, workflow);
  };
  /** `do` and its catalog as the scope sees them; an agent never falls back to the operator's. */
  const verbOf = (scope: Scope): Pick<Backend, "abilities"> & { do: Backend["do"]["do"] } =>
    scope.operator
      ? { do: (r) => deps.do.do(r), abilities: () => deps.abilities() }
      : (deps.doAs?.(scope) ?? {
          do: async () => {
            throw new DoError(501, "no scoped do here");
          },
          abilities: async () => [],
        });
  app.use("*", (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") deps.touch?.();
    return next();
  });
  app.use("/hooks/*", rateLimit({ perMinute: limits.hooks }));
  app.use("/hooks/inbound", bearerAuth(deps.token));
  // Linq cannot send our bearer; its signature stands in when a secret is set.
  app.use("/hooks/linq", (c, next) =>
    deps.linq?.secret ? next() : bearerAuth(deps.token)(c, next),
  );

  /** Fixed at boot except the workflow list (compiles), the model spend (every call) and the screen. */
  app.get("/api/status", async (c) =>
    c.json(
      deps.status
        ? {
            ...deps.status,
            browser: { ...deps.status.browser, headless: deps.screen.headless },
            workflows: (await workflows())
              .map((w) => w.name)
              .filter((n) => allowsWorkflow(scopeOf(c), n)),
            ...(deps.budget ? { budget: deps.budget() } : {}),
          }
        : null,
    ),
  );

  /** Both ledgers since `?since=<iso>` (default: the last 24 h): secret uses and gate decisions, never a value. */
  app.get("/api/ledger", async (c) => {
    if (!deps.ledger) return fail(c, 501, "no ledger here");
    const q = readQuery(c, ledgerQuery);
    if (!q.ok) return q.res;
    return c.json(await deps.ledger(q.data.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000)));
  });

  /** The live settings: one resource, read and replaced as a whole. Today: `headless`. */
  app.get("/api/settings", (c) => c.json(settingsView(deps)));
  app.put("/api/settings", async (c) => {
    const body = await readJson(c, liveSettings);
    if (!body.ok) return body.res;
    deps.screen.headless = body.data.headless;
    return c.json(settingsView(deps));
  });

  app.get("/api/workflows", async (c) => {
    const proven = await proofs();
    const scope = scopeOf(c);
    return c.json(
      (await workflows())
        .filter((w) => allowsWorkflow(scope, w.name))
        .map((w) => ({
          name: w.name,
          description: w.description,
          steps: w.steps.map((s) => ({ name: s.name, irreversible: s.irreversible ?? false })),
          plan: jsonSchemaOf(w.plan),
          // Hand-written flows are proven by their tests; compiled ones by one run after compiling.
          proof: w.name in proven ? (proven[w.name] ?? null) : undefined,
        })),
    );
  });

  /**
   * A proof is a run of its own (gates declined, plan defaults), so it is
   * not a Restate run. Minutes long: a job, answered at once and polled.
   */
  const jobs = deps.jobs ?? new Jobs();
  /** 201 with the new agent session, and where it lives. */
  const created = (c: Context, view: { id: string }) => {
    c.header("Location", `/api/agent/${view.id}`);
    return c.json(view, 201);
  };
  /** 202 with the job, and where to poll it. */
  const accepted = (c: Context, job: JobView) => {
    c.header("Location", `/api/jobs/${job.id}`);
    return c.json(job, 202);
  };
  /** Sign-ins by site: what is stored (never the values), add/change, and a headless sign-in as the proof. */
  app.get("/api/accounts", async (c) => c.json(await deps.accounts.list()));
  app.put("/api/accounts/:site", async (c) => {
    const path = readPath(c, siteParam);
    if (!path.ok) return path.res;
    const body = await readJson(c, accountEdit);
    if (!body.ok) return body.res;
    try {
      return c.json(await deps.accounts.save(path.data.site, body.data));
    } catch (err) {
      return fail(c, 400, err instanceof Error ? err.message : String(err), {
        code: "invalid_body",
      });
    }
  });
  app.post("/api/accounts/:site/check", (c) => {
    const path = readPath(c, siteParam);
    if (!path.ok) return path.res;
    const { site } = path.data;
    return accepted(
      c,
      jobs.start("login", site, () => deps.accounts.check(site)),
    );
  });

  /** What only the person can give, with each row's check; a decision is marked done here (never a value). */
  app.get("/api/needs", async (c) => {
    if (!deps.owed) return fail(c, 501, "no owed list here");
    const owed = await deps.owed.rows();
    return c.json({
      ...owed,
      rows: owed.rows.map((r) => ({ ...r, actions: needAffordances(r) })),
    });
  });
  const doneBody = z.object({ note: z.string().max(500).optional() });
  app.post("/api/needs/:id/done", async (c) => {
    if (!deps.owed) return fail(c, 501, "no owed list here");
    const body = await readJson(c, doneBody);
    if (!body.ok) return body.res;
    deps.touch?.();
    await deps.owed.done(c.req.param("id"), body.data.note);
    return c.json({ ok: true });
  });
  app.delete("/api/needs/:id/done", async (c) => {
    if (!deps.owed) return fail(c, 501, "no owed list here");
    deps.touch?.();
    await deps.owed.undo(c.req.param("id"));
    return c.json({ ok: true });
  });
  /** Which account is for what, and how ready each is; `use` moves a purpose. */
  app.get("/api/policy", async (c) =>
    deps.policy ? c.json(await deps.policy.list()) : fail(c, 501, "no policy here"),
  );
  const useBody = z.object({ purpose: z.string().min(1).max(40), address: z.string().email() });
  app.put("/api/policy/use", async (c) => {
    if (!deps.policy) return fail(c, 501, "no policy here");
    const body = await readJson(c, useBody);
    if (!body.ok) return body.res;
    deps.touch?.();
    try {
      await deps.policy.use(body.data.purpose, body.data.address);
      return c.json(await deps.policy.list());
    } catch (err) {
      return fail(c, 400, err instanceof Error ? err.message : String(err), {
        code: "invalid_body",
      });
    }
  });

  // Mods: the page adds data mods only; a code mod is refused here and added from the CLI with --trust.
  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
  app.get("/api/mods", (c) =>
    deps.mods ? c.json(deps.mods.list()) : fail(c, 501, "no mods here"),
  );
  const searchQuery = z.object({ q: z.string().max(200).default("") });
  app.get("/api/mods/search", async (c) => {
    if (!deps.mods) return fail(c, 501, "no mods here");
    const q = readQuery(c, searchQuery);
    if (!q.ok) return q.res;
    try {
      return c.json(await deps.mods.search(q.data.q));
    } catch (err) {
      return fail(c, 502, message(err));
    }
  });
  const sourceBody = z.object({ source: z.string().min(1).max(500) });
  app.post("/api/mods/check", async (c) => {
    if (!deps.mods) return fail(c, 501, "no mods here");
    const body = await readJson(c, sourceBody);
    if (!body.ok) return body.res;
    try {
      return c.json(await deps.mods.check(body.data.source));
    } catch (err) {
      return fail(c, 400, message(err));
    }
  });
  app.post("/api/mods", async (c) => {
    if (!deps.mods) return fail(c, 501, "no mods here");
    const body = await readJson(c, sourceBody);
    if (!body.ok) return body.res;
    deps.touch?.();
    try {
      await deps.mods.add(body.data.source);
      return c.json({ ok: true });
    } catch (err) {
      return fail(c, 400, message(err));
    }
  });
  app.delete("/api/mods/:name{.+}", (c) => {
    if (!deps.mods) return fail(c, 501, "no mods here");
    deps.touch?.();
    try {
      return deps.mods.remove(c.req.param("name"))
        ? c.json({ ok: true })
        : fail(c, 404, "no such mod");
    } catch (err) {
      return fail(c, 400, message(err));
    }
  });

  /** One verb: a goal in, what ran (or what the agent built) out. A dry run answers at once; the rest is a job. */
  const doBody = z.object({
    goal: z.string().min(1).max(2000),
    inputs: z.record(z.string(), z.string()).default({}),
    site: z.string().regex(SITE).nullable().default(null),
    url: z.string().url().nullable().default(null),
    dryRun: z.boolean().default(false),
  });
  app.get("/api/abilities", async (c) => c.json(await verbOf(scopeOf(c)).abilities()));
  app.post("/api/do", async (c) => {
    const body = await readJson(c, doBody);
    if (!body.ok) return body.res;
    const scope = scopeOf(c);
    if (body.data.site && !allowsSite(scope, body.data.site))
      return fail(c, 403, `this key may not use ${body.data.site}`);
    const verb = verbOf(scope);
    if (body.data.dryRun) {
      try {
        return c.json(await verb.do(body.data));
      } catch (err) {
        if (err instanceof DoError) return fail(c, err.status, err.message);
        throw err;
      }
    }
    return accepted(
      c,
      jobs.start("do", body.data.goal.slice(0, 60), () => verb.do(body.data), scope.name),
    );
  });

  app.post("/api/workflows/:name/prove", async (c) => {
    const { name } = c.req.param();
    const prove = deps.prove;
    if (!prove) return fail(c, 501, "no browser here to prove with");
    if (!(name in (await proofs()))) return fail(c, 404, `${name} is not a compiled workflow`);
    return accepted(
      c,
      jobs.start("prove", name, () => prove(name)),
    );
  });
  /** The outline is the edit surface of a compiled flow; hand-written ones have none (404). */
  app.get("/api/workflows/:name/outline", async (c) => {
    const outline = await deps.outline?.load(c.req.param("name"));
    return outline ? c.json(outline) : fail(c, 404, "no outline: not a compiled workflow");
  });
  app.put("/api/workflows/:name/outline", async (c) => {
    const { name } = c.req.param();
    if (!deps.outline) return fail(c, 501, "no compiled workflows here");
    if (!(await deps.outline.load(name)))
      return fail(c, 404, "no outline: not a compiled workflow");
    const body = await readJson(c, outlineSchema);
    if (!body.ok) return body.res;
    if (body.data.name !== name)
      return fail(c, 400, `name: the outline's name must stay ${name}: it is the directory`, {
        code: "invalid_body",
      });
    return c.json(await deps.outline.save(name, body.data));
  });

  /**
   * Site APIs: a service under its official REST shape (`POST
   * /api/sites/linkedin/rest/posts` is LinkedIn's Posts API). The API leg
   * answers with a token, the browser leg without; one client either way.
   * Setup steps make the site's keys and tokens (minutes: a job).
   */
  app.get("/api/sites", async (c) =>
    deps.sites
      ? c.json((await deps.sites.list()).filter((r) => seesSite(scopeOf(c), r.site)))
      : fail(c, 501, "no site apis here"),
  );
  app.get("/api/sites/:site", async (c) => {
    if (!deps.sites) return fail(c, 501, "no site apis here");
    const path = readPath(c, siteParam);
    if (!path.ok) return path.res;
    try {
      const row = await deps.sites.status(path.data.site);
      return c.json({ ...row, actions: setupAffordances(row) });
    } catch (err) {
      return siteError(c, err);
    }
  });
  app.post("/api/sites/:site/setup/:step", async (c) => {
    const sites = deps.sites;
    if (!sites) return fail(c, 501, "no site apis here");
    const path = readPath(c, siteParam.extend({ step: z.string().regex(NAME) }));
    if (!path.ok) return path.res;
    const { site, step } = path.data;
    try {
      const row = (await sites.status(site)).setup.find((s) => s.name === step);
      if (!row) return fail(c, 404, `no setup step ${step} on ${site}`);
      if (row.blockedOn.length) return fail(c, 409, `needs ${row.blockedOn.join(", ")} first`);
      return accepted(
        c,
        jobs.start("setup", `${site}/${step}`, () =>
          sites.setup(site, step, c.req.query("account") ?? null),
        ),
      );
    } catch (err) {
      return siteError(c, err);
    }
  });
  app.all("/api/sites/:site/*", async (c) => {
    const sites = deps.sites;
    if (!sites) return fail(c, 501, "no site apis here");
    const site = c.req.param("site");
    if (!SITE.test(site)) return fail(c, 400, `not a site: ${site}`, { code: "invalid_path" });
    const path = new URL(c.req.url).pathname.slice(`/api/sites/${site}`.length);
    const method = c.req.method as Method;
    let body: Record<string, unknown> = {};
    if (method !== "GET" && method !== "DELETE") {
      const read = await readJson(c, z.record(z.string(), z.unknown()));
      if (!read.ok) return read.res;
      body = read.data;
    }
    try {
      // `account` picks the identity; it is not part of the site's own query.
      const { account, ...query } = c.req.query();
      return c.json(await sites.call(site, method, path, { ...query, ...body }, account ?? null));
    } catch (err) {
      return siteError(c, err);
    }
  });
  /** Newest first, at most the 100 kept; `?status=running,failed` and `?kind=prove` narrow it. */
  app.get("/api/jobs", (c) => {
    const q = readQuery(c, jobsQuery);
    if (!q.ok) return q.res;
    const scope = scopeOf(c);
    const { status, kind, limit } = q.data;
    return c.json(
      jobs
        .list()
        .filter(
          (j) =>
            (scope.operator || j.by === scope.name) &&
            (!status || status.includes(j.status)) &&
            (!kind || j.kind === kind),
        )
        .slice(0, limit),
    );
  });
  /** `?wait=<ms>` (30s at most) holds the answer until the job settles: one request, not a poll loop. */
  app.get("/api/jobs/:id", async (c) => {
    const q = readQuery(c, jobQuery);
    if (!q.ok) return q.res;
    const scope = scopeOf(c);
    const job = await jobs.wait(c.req.param("id"), q.data.wait);
    return job && (scope.operator || job.by === scope.name)
      ? c.json(job)
      : fail(c, 404, "no such job");
  });

  /**
   * Newest first; `?limit=` (100, 500 at most), `?status=waiting,running`,
   * `?workflow=domain`. The registry filters before it pages, so a filtered
   * page is full. More rows: `Link: <…?before=<cursor>>; rel="next"`.
   */
  app.get("/api/runs", async (c) => {
    const q = readQuery(c, runsQuery);
    if (!q.ok) return q.res;
    const { limit, before, status, workflow } = q.data;
    const scope = scopeOf(c);
    // One extra row says whether another page follows.
    const rows = await deps.ingress.registry().list({
      limit: limit + 1,
      ...(before ? { before } : {}),
      ...(status ? { status } : {}),
      ...(workflow ? { workflow } : {}),
    });
    const shown = rows.slice(0, limit);
    const last = shown.at(-1);
    const next = rows.length > limit && last ? cursorOf(last) : null;
    // An agent's page is cut to its scope after paging: it can come back short, the link still pages on.
    return page(
      c,
      scope.operator ? shown : shown.filter((r) => visibleRun(scope, r.workflow, r.key)),
      next,
    );
  });

  app.get("/api/runs/:workflow/:key", async (c) => {
    const path = readPath(c, runParams);
    if (!path.ok) return path.res;
    const { workflow, key } = path.data;
    if (!(await find(workflow))) return fail(c, 404, `no workflow ${workflow}`);
    const status = await runOf(workflow, key).status();
    return c.json({ ...status, actions: runAffordances(status) });
  });

  /** Start (or resume) the run at this key: 202, `Location` is the run. */
  app.post("/api/runs/:workflow/:key", async (c) => {
    const path = readPath(c, runParams);
    if (!path.ok) return path.res;
    const { workflow, key } = path.data;
    const w = await find(workflow);
    if (!w) return fail(c, 404, `no workflow ${workflow}`);
    const body = await readJson(c, z.object({ plan: w.plan }));
    if (!body.ok) return body.res;
    await runOf(workflow, key).run(body.data.plan);
    c.header("Location", `/api/runs/${workflow}/${encodeURIComponent(key)}`);
    return c.json({ ok: true }, 202);
  });

  app.post("/api/runs/:workflow/:key/:action", async (c) => {
    const path = readPath(c, runParams.extend({ action: z.string() }));
    if (!path.ok) return path.res;
    const { workflow, key, action } = path.data;
    if (!(await find(workflow))) return fail(c, 404, `no workflow ${workflow}`);
    if (!isAction(action)) return fail(c, 404, `no action ${action}: one of ${ACTIONS.join(", ")}`);
    const body = await readJson(c, actionBody);
    if (!body.ok) return body.res;
    const run = runOf(workflow, key);
    if (action === "approve" || action === "reject") {
      const name = body.data.name ?? (await run.status()).gate?.name;
      if (!name) return fail(c, 409, `${workflow}/${key} has no open gate`);
      const args = { name: name as GateName, ...(body.data.note ? { note: body.data.note } : {}) };
      return c.json(action === "approve" ? await run.approve(args) : await run.reject(args));
    }
    await run[action]();
    return c.json({ ok: true });
  });

  /** Live feed: everything since `after`, then each new event; a comment every 15s keeps proxies awake. */
  app.get("/api/events", (c) => {
    const q = readQuery(c, eventsQuery);
    if (!q.ok) return q.res;
    // A reconnecting EventSource sends where it stopped as `Last-Event-ID`.
    const after = Math.max(q.data.after, Number(c.req.header("last-event-id")) || 0);
    const scope = scopeOf(c);
    return streamSSE(c, async (stream) => {
      const send = async (seq: number, event: RunEvent) => {
        if (!visibleRun(scope, event.run.workflow, event.run.key)) return;
        await stream.writeSSE({ id: String(seq), event: event.type, data: JSON.stringify(event) });
      };
      // Subscribe first so nothing lands between the replay and the live feed; hold those until the replay is out.
      let replaying = true;
      let last = after;
      const held: Array<[number, RunEvent]> = [];
      const unsubscribe = deps.bus.subscribe((seq, event) => {
        if (replaying) held.push([seq, event]);
        else void send(seq, event);
      });
      for (const e of deps.bus.recent(after)) {
        await send(e.seq, e.event);
        last = e.seq;
      }
      for (const [seq, event] of held) if (seq > last) await send(seq, event);
      replaying = false;
      let open = true;
      stream.onAbort(() => {
        open = false;
        unsubscribe();
      });
      while (open) {
        await stream.sleep(15_000);
        if (open) await stream.write(": keepalive\n\n");
      }
    });
  });

  /** Newest first; `?site=`, `?limit=` (100), `?before=<startedAt~name>`, `Link` rel="next" when more. */
  app.get("/api/recordings", async (c) => {
    const q = readQuery(c, recordingsQuery);
    if (!q.ok) return q.res;
    const { limit, before, site } = q.data;
    const cursor = (r: { startedAt: string; name: string }) => `${r.startedAt}~${r.name}`;
    // Summaries are newest first with ties by name descending, the same order the cursor compares in.
    const rows = (await listRecordingSummaries(deps.recordingsDir)).filter(
      (r) => (!site || r.site === site) && (!before || cursor(r) < before),
    );
    const shown = rows.slice(0, limit);
    const last = shown.at(-1);
    return page(c, shown, rows.length > limit && last ? cursor(last) : null);
  });

  app.get("/api/recordings/:name", async (c) => {
    const path = readPath(c, recordingParam);
    if (!path.ok) return path.res;
    try {
      return c.json(await loadRecording(deps.recordingsDir, path.data.name));
    } catch {
      return fail(c, 404, `no recording ${path.data.name}`);
    }
  });

  app.get("/api/recordings/:name/files/*", (c) => {
    const path = readPath(c, recordingParam);
    if (!path.ok) return path.res;
    const rel = c.req.path.split(`/files/`).slice(1).join("/files/");
    return (
      serveUnder(recordingDir(deps.recordingsDir, path.data.name), decodeURIComponent(rel)) ??
      fail(c, 404, "no such file")
    );
  });

  app.post("/api/recordings/:name/compile", async (c) => {
    const path = readPath(c, recordingParam);
    if (!path.ok) return path.res;
    const rec = await loadRecording(deps.recordingsDir, path.data.name).catch(() => null);
    if (!rec) return fail(c, 404, `no recording ${path.data.name}`);
    return c.json(await deps.compile(rec));
  });

  /** Gate screenshots and traces live under the artifacts dir; the status gives absolute paths. */
  app.get("/api/artifacts", (c) => {
    const q = readQuery(c, z.object({ path: z.string().min(1) }));
    if (!q.ok) return q.res;
    return serveUnder(deps.artifactsDir, resolve(q.data.path)) ?? fail(c, 404, "no such file");
  });

  app.get("/api/agent", (c) =>
    c.json(
      (deps.agent?.list() ?? [])
        .filter((v) => allowsSite(scopeOf(c), v.site))
        .map(summarizeSession),
    ),
  );
  /** The evaluator: which recurring needs deserve a workflow, from failures, sessions and recordings. */
  app.get("/api/agent/proposals", async (c) => {
    if (!deps.llm) return fail(c, 501, "no model configured: set LLM_PROVIDER");
    const recordings = (await listRecordingSummaries(deps.recordingsDir)).map((r) => ({
      name: r.name,
      site: r.site,
    }));
    try {
      return c.json(
        await proposeWorkflows(deps.llm, {
          failures: await readFailures(deps.artifactsDir),
          sessions: deps.agent?.list() ?? [],
          recordings,
        }),
      );
    } catch (err) {
      return fail(c, 502, err instanceof Error ? err.message : String(err));
    }
  });
  /** A failed compiled step healed in place: rewritten from what the agent did, then proven. Minutes: a job. */
  app.post("/api/agent/heal", async (c) => {
    const heal = deps.heal;
    if (!heal) return fail(c, 501, "healing needs a model and a browser here");
    const body = await readJson(c, repairBody);
    if (!body.ok) return body.res;
    let record: FailureRecord;
    try {
      record = readFailure(body.data.failure, deps.artifactsDir);
    } catch (err) {
      return fail(c, 400, err instanceof Error ? err.message : String(err), {
        code: "invalid_body",
      });
    }
    return accepted(
      c,
      jobs.start("heal", `${record.site}/${record.flow}`, () => heal(record)),
    );
  });
  /** A failed step's record → an agent session on that page toward the flow's goal. */
  app.post("/api/agent/repair", async (c) => {
    if (!deps.agent) return fail(c, 501, "no model configured: set LLM_PROVIDER");
    const body = await readJson(c, repairBody);
    if (!body.ok) return body.res;
    let record: FailureRecord;
    try {
      record = readFailure(body.data.failure, deps.artifactsDir);
    } catch (err) {
      return fail(c, 400, err instanceof Error ? err.message : String(err), {
        code: "invalid_body",
      });
    }
    return created(c, await deps.agent.start(repairRequest(record, body.data.goal)));
  });
  app.post("/api/agent", async (c) => {
    if (!deps.agent) return fail(c, 501, "no model configured: set LLM_PROVIDER");
    const body = await readJson(c, agentStart);
    if (!body.ok) return body.res;
    const { url, inputs, maxSteps, ...rest } = body.data;
    if (!allowsSite(scopeOf(c), rest.site))
      return fail(c, 403, `this key may not use ${rest.site}`);
    return created(
      c,
      await deps.agent.start({
        ...rest,
        ...(inputs ? { inputs } : {}),
        ...(maxSteps ? { maxSteps } : {}),
        url: url ?? null,
      }),
    );
  });
  app.get("/api/agent/:id", (c) => {
    const view = deps.agent?.get(c.req.param("id"));
    return view ? c.json(view) : fail(c, 404, "no such session");
  });
  app.get("/api/agent/:id/shot/:n", (c) => {
    const path = readPath(c, z.object({ id: z.string(), n: z.coerce.number().int().min(0) }));
    if (!path.ok) return path.res;
    const view = deps.agent?.get(path.data.id);
    if (!view) return fail(c, 404, "no such session");
    const step = view.steps[path.data.n];
    if (!step?.screenshot) return fail(c, 404, `no screenshot at step ${path.data.n}`);
    return serveUnder(deps.recordingsDir, resolve(step.screenshot)) ?? fail(c, 404, "no such file");
  });
  /** A person's own explore command on a paused session; the reply is what the explore socket would say. */
  app.post("/api/agent/:id/exec", async (c) => {
    if (!deps.agent) return fail(c, 501, "no model configured: set LLM_PROVIDER");
    const id = c.req.param("id");
    if (!deps.agent.get(id)) return fail(c, 404, "no such session");
    const body = await readJson(c, commandSchema);
    if (!body.ok) return body.res;
    try {
      return c.json({ result: await deps.agent.exec(id, body.data) });
    } catch (err) {
      // The command ran and failed on the page (no such element, a paused session wanted): not now.
      return fail(c, 409, err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err));
    }
  });
  app.post("/api/agent/:id/:action", async (c) => {
    const { id, action } = c.req.param();
    if (!deps.agent) return fail(c, 501, "no model configured: set LLM_PROVIDER");
    if (!(AGENT_ACTIONS as readonly string[]).includes(action))
      return fail(c, 404, `no action ${action}: one of ${AGENT_ACTIONS.join(", ")}`);
    if (!deps.agent.get(id)) return fail(c, 404, "no such session");
    const body = await readJson(c, agentAction);
    if (!body.ok) return body.res;
    try {
      switch (action as (typeof AGENT_ACTIONS)[number]) {
        case "pause":
          return c.json(await deps.agent.pause(id));
        case "resume":
          return c.json(await deps.agent.resume(id));
        case "stop":
          return c.json(await deps.agent.stop(id));
        case "close":
          return c.json(await deps.agent.close(id));
        case "save": {
          const name = body.data.name ?? deps.agent.get(id)?.goal.replace(/[^a-z0-9]+/gi, "-");
          if (!name || !NAME.test(name.toLowerCase()))
            return fail(c, 400, "name: a recording name: lowercase, dashes", {
              code: "invalid_body",
            });
          return c.json(await deps.agent.save(id, name.toLowerCase()));
        }
      }
    } catch (err) {
      // The session exists (checked above): what failed is the action in its current state.
      return fail(c, 409, err instanceof Error ? err.message : String(err));
    }
  });

  /** What a person typed on any channel becomes a command; the answer is one line for that channel. */
  async function inbound(text: string): Promise<string> {
    const cmd = parseCommand(text, { workflows: (await workflows()).map((w) => w.name) });
    if (!cmd) return "say yes, no, pause, play, status or reset, optionally with <workflow> <key>";
    const registry = deps.ingress.registry();
    const target: RunRow | undefined = cmd.run
      ? await findRow(
          registry,
          (r) => r.workflow === cmd.run?.workflow && r.key === cmd.run?.key,
          10,
          { workflow: cmd.run.workflow },
        )
      : cmd.kind === "approve" || cmd.kind === "reject"
        ? (await registry.list({ status: ["waiting"], limit: 1 }))[0]
        : (await registry.list({ limit: 1 }))[0];
    if (!target) return cmd.run ? `no run ${cmd.run.workflow}/${cmd.run.key}` : "no run is waiting";
    const run = runOf(target.workflow, target.key);
    const id = `${target.workflow}/${target.key}`;
    switch (cmd.kind) {
      case "approve":
      case "reject": {
        const gate = (await run.status()).gate;
        if (!gate) return `${id} is not waiting at a gate`;
        const args = { name: gate.name, ...(cmd.note ? { note: cmd.note } : {}) };
        await (cmd.kind === "approve" ? run.approve(args) : run.reject(args));
        return `${id}: ${gate.name} ${cmd.kind === "approve" ? "approved" : "rejected"}`;
      }
      case "status": {
        const s = await run.status();
        const line = s.gate
          ? `waiting at ${s.gate.step}: ${s.gate.prompt}`
          : s.outcome
            ? s.outcome.status
            : "running";
        return `${id}: ${line}${s.paused ? " (paused)" : ""}`;
      }
      default:
        await run[cmd.kind]();
        return `${id}: ${cmd.kind === "play" ? "playing" : cmd.kind}`;
    }
  }

  app.post("/hooks/inbound", async (c) => {
    const body = await readJson(c, inboundBody);
    if (!body.ok) return body.res;
    return c.json({ reply: await inbound(body.data.text) });
  });

  /** Linq posts `message.received` here; the reply goes back over iMessage. Signature required when a secret is set. */
  app.post("/hooks/linq", async (c) => {
    const linq = deps.linq;
    if (!linq) return fail(c, 404, "linq is not configured");
    const raw = await c.req.text();
    if (linq.secret) {
      const ok = verifyLinqWebhook(
        {
          "webhook-id": c.req.header("webhook-id"),
          "webhook-timestamp": c.req.header("webhook-timestamp"),
          "webhook-signature": c.req.header("webhook-signature"),
        },
        raw,
        linq.secret,
      );
      if (!ok) return fail(c, 401, "bad signature");
    }
    let event: LinqEvent;
    try {
      event = linqEvent.parse(JSON.parse(raw));
    } catch (err) {
      return err instanceof z.ZodError
        ? fail(c, 400, "not a Linq event", { code: "invalid_body" })
        : fail(c, 400, "body is not valid JSON", { code: "invalid_json" });
    }
    if (event.type !== "message.received") return c.json({ ignored: event.type });
    const from = event.data.from;
    if (!from || from !== linq.to) return c.json({ ignored: "not the operator" });
    if (event.data.chat_id) linq.client.learn(from, event.data.chat_id);
    const text = textOf(event.data);
    if (!text) return c.json({ ignored: "no text" });
    const reply = await inbound(text);
    await linq.client.send(from, reply);
    return c.json({ reply });
  });

  // Mounted under the UI server, its SPA fallback would answer an unknown API path with HTML: answer here first.
  const noRoute = (c: Context) => fail(c, 404, `no route ${c.req.method} ${c.req.path}`);
  app.all("/api/*", noRoute);
  app.all("/hooks/*", noRoute);
  return app;
}
