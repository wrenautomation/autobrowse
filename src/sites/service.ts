/**
 * The site facade as the Restate service `sites`, for an orchestrator on the
 * same Restate (wren): `sites/call` is one official-API call, `sites/status`
 * the routes and setup rows, `sites/setup` one setup step, `sites/renew` every token about to lapse,
 * `sites/caps` a day's capped reads and who made them. The worker dials
 * Restate, so a call queues while the box is down and answers when it is up:
 * no inbound port, no reachability from the caller's side. A `SiteError` is
 * terminal under its own status; a write runs once (an irreversible post is
 * never retried into a duplicate), a read retries like a browser leg.
 * `sites/arm` takes a call and runs its browser leg up to the last safe step, answering an arm
 * id the real call carries (`armId`).
 * A token the platform refuses (`refused.ts`) queues its re-make here, once per incident:
 * `renew` for that name alone, one-way. `sites/revoke` ends a grant and queues the same.
 * With watchers (the desk), `watch` leases a tab watcher, `unwatch` ends one, `watches` lists them.
 * A busy browser profile is waited for, durably, never a failure (`browser/profile-wait`); a
 * write that fails says whether it was sent: `not sent: …` before its submit step, `…; may have
 * gone through` after it.
 * A write with a `sendKey` answers a typed `SendVerdict` instead (`verdict.ts`, designs/2026-10-16-
 * send-verdicts.md): the send journal keeps what went out per key, an unclear end is settled by the
 * route's verify read, and `verdict` answers a key without a call. Restate's own idempotency is the
 * caller's header (set it to the send key); nothing here dedupes invocations.
 */
import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import { KeyError } from "../auth/keys.js";
import { type CallTry, withCall } from "../browser/attempt.js";
import { profileBusyOf } from "../browser/browsers.js";
import {
  MAY_HAVE_GONE_THROUGH,
  NOT_SENT,
  PROFILE_BUSY_STATUS,
  type ProfileWait,
  waitForProfile,
} from "../browser/profile-wait.js";
import type { Watchers } from "../browser/watchers.js";
import { HttpError, lastingRefusal } from "../clients/http.js";
import type { RunObject } from "../engine/object.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import { named } from "../owner.js";
import type { SiteCalls } from "../runs/calls.js";
import { COMPILED_OBJECT, compiledKey } from "../workflows/compiled.js";
import type { SendSpec, SiteFacade } from "./facade.js";
import {
  type KeyAdmin,
  type KeyRevokeAnswer,
  type KeyRotateAnswer,
  type KeyRow,
  keyRevokeRequest,
  keyRotateRequest,
  keySpendRequest,
  keysRequest,
} from "./keys.js";
import type { RefusedToken } from "./refused.js";
import type { RenewReport } from "./renew.js";
import { memorySendJournal, type SendJournal, type SendRecord } from "./send-journal.js";
import { SiteError } from "./types.js";
import { isFinal, type Seen, type SendVerdict, settle, type VerifyGet } from "./verdict.js";

export const SITES_SERVICE = "sites";
/**
 * The same facade served from the Mac (`src/app/desk.ts`): legs a site
 * refuses from the box's datacenter IP (Reddit) run on a home IP.
 */
export const DESK_SERVICE = "desk";

const READ_RETRY = {
  maxRetryAttempts: 300,
  initialRetryInterval: 1_000,
  retryIntervalFactor: 2,
  maxRetryInterval: 300_000,
};
const WRITE_RETRY = { maxRetryAttempts: 1 };
/**
 * Tries of a read before a platform's 429, 5xx or timeout on the API leg goes back to the
 * caller (wren pauses and asks again a few times): 300 tries a day, each up to three HTTP
 * calls, only pile on a platform that is already saying no. A browser leg keeps waiting.
 */
const API_READ_TRIES = 4;

/** `account`: which identity's token (a consented address); the site's own when absent. */
const site = z.object({ site: z.string().min(1), account: z.string().min(1).optional() });
const call = site.extend({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().startsWith("/"),
  input: z.record(z.string(), z.unknown()).default({}),
  /** Who is asking (`wren:demo`), for the caps ledger; the `x-caller` header says it too. */
  caller: z.string().min(1).max(120).optional(),
  /** An earlier `arm`'s id: the leg runs in its tab, already on the page. */
  armId: z.string().uuid().optional(),
  /** A write with a key answers a `SendVerdict`, once per key (`send-journal.ts`). */
  sendKey: z.string().min(1).max(200).optional(),
  /**
   * A write's day ends here (ISO time). A write the desk first runs past it is not sent: the Mac
   * was off for its whole day, so it goes back to its caller and never lands a day late.
   */
  until: z.string().datetime({ offset: true }).optional(),
});
const verdictReq = z.object({ sendKey: z.string().min(1).max(200) });
const setup = site.extend({ step: z.string().min(1) });
const revoke = site.extend({
  /** Minutes before the re-make runs (a consent screen filmed first); at once by default. */
  after: z
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .default(0),
});
const renewReq = z.object({
  dry: z.boolean().default(false),
  /** Only these refused names, made again now: a queued re-make. Every due token when absent. */
  names: z.array(z.string().min(1)).min(1).optional(),
});

/** The door a re-make goes through: this service's own `renew`. */
type Renewer = {
  renew: (ctx: restate.Context, req: z.input<typeof renewReq>) => Promise<RenewReport>;
};

/** One incident's re-make: every send and wait on it shares the one run. */
const remakeKey = (r: { name: string; since: string }) => `remake ${r.name} ${r.since}`;

/**
 * Wait for one refused token's re-make: true when it made the name again. The same key as
 * `queueRemake`, so this joins a queued run (or reads its answer) instead of starting another.
 */
async function awaitRemake(
  ctx: restate.Context,
  service: string,
  r: Pick<RefusedToken, "name" | "since">,
): Promise<boolean> {
  const report = await ctx
    .serviceClient<Renewer>({ name: service })
    .renew({ names: [r.name] }, restate.rpc.opts({ idempotencyKey: remakeKey(r) }))
    .catch(() => null);
  return Boolean(report?.results.some((x) => x.ok && x.names.includes(r.name)));
}

/**
 * Queue `renew` for each name, once per incident (the key is the name and since when): durable,
 * so it runs when the worker can, even after a crash between here and there.
 */
function queueRemake(
  ctx: restate.Context,
  service: string,
  rows: readonly { name: string; since: string }[],
  delayMs = 0,
) {
  for (const r of rows)
    ctx.serviceSendClient<Renewer>({ name: service }).renew(
      { names: [r.name] },
      restate.rpc.sendOpts({
        idempotencyKey: remakeKey(r),
        ...(delayMs ? { delay: delayMs } : {}),
      }),
    );
}

/** A request the shape rejects is the caller's mistake: terminal 400, nothing ran. */
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new restate.TerminalError(r.error.message, { errorCode: 400 });
  return r.data;
}

/**
 * A failed write's words say whether it left: `not sent: …` when its submit step never started,
 * `…; may have gone through` when it did. Words that already say either stay as they are.
 */
export function sentWords(message: string, submitted: boolean): string {
  if (message.startsWith(NOT_SENT) || message.includes(MAY_HAVE_GONE_THROUGH)) return message;
  return submitted ? `${message}; ${MAY_HAVE_GONE_THROUGH}` : `${NOT_SENT}${message}`;
}

/** A coded SiteError's code as Restate error metadata (`metadata.code` in the ingress answer). */
const codeOf = (err: unknown): { metadata?: Record<string, string> } =>
  err instanceof SiteError && err.code ? { metadata: { code: err.code } } : {};

/**
 * A SiteError is the caller's to read (404 route, 400 request, 501 no leg, 409 blocked, 502 failed),
 * and so is a platform's lasting refusal; nothing else is.
 * Runs as the durable call `key`: a browser leg's irreversible act (a post) that went
 * through before a crash or a lost connection is not done again when Restate reruns it.
 * A busy profile goes on as it is: `waitForProfile` waits it out.
 * `write`: a write runs once, so whatever ends it is terminal here, its words saying whether
 * it was sent (`sentWords`); a refusal before any page (a SiteError under 500) as it is.
 */
async function terminalOnSiteError<T>(
  key: string,
  fn: () => Promise<T>,
  /** Which try this is, for a read: past `API_READ_TRIES` a platform's HTTP failure is terminal too. */
  attempt?: number,
  write = false,
): Promise<T> {
  const t: CallTry = { key, submitted: false };
  try {
    return await withCall(key, fn, t);
  } catch (err) {
    if (profileBusyOf(err)) throw err;
    if (write && !(err instanceof restate.TerminalError)) {
      const status =
        err instanceof SiteError || lastingRefusal(err) ? (err as SiteError).status : 500;
      const message = err instanceof Error ? err.message : String(err);
      throw new restate.TerminalError(status < 500 ? message : sentWords(message, t.submitted), {
        errorCode: status,
        ...codeOf(err),
      });
    }
    if (err instanceof SiteError || lastingRefusal(err))
      throw new restate.TerminalError(err.message, {
        errorCode: err.status,
        ...codeOf(err),
      });
    if (attempt !== undefined && attempt >= API_READ_TRIES && err instanceof HttpError)
      throw new restate.TerminalError(err.message, {
        errorCode: err.status >= 400 ? err.status : 502,
      });
    throw err;
  }
}

/**
 * A call can be one long step: a video's bytes run for minutes. Restate's default timeouts cut
 * such a step off mid-upload (every ~3 minutes on 10-07) and rerun it, so the bytes never finish.
 */
const CALL_MS = 2 * 60 * 60_000;
const CALL_OPTS = { inactivityTimeout: CALL_MS, abortTimeout: CALL_MS };

/**
 * Each try of `fn` as one ledger line: ok, or the error and whether the caller gets it.
 * Inside `ctx.run`, so a replay (answered from the journal) writes nothing.
 */
async function recorded<T>(
  calls: SiteCalls | undefined,
  base: { service: string; site: string; route: string; caller: string | null; invocation: string },
  attempt: number,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  const at = new Date(t0).toISOString();
  try {
    const out = await fn();
    calls?.record({
      ...base,
      at,
      attempt,
      ok: true,
      status: null,
      terminal: false,
      error: null,
      ms: Date.now() - t0,
    });
    return out;
  } catch (err) {
    const terminal = err instanceof restate.TerminalError;
    const status = terminal ? (err.code ?? null) : null;
    const error = err instanceof Error ? err.message : String(err);
    calls?.record({
      ...base,
      at,
      attempt,
      ok: false,
      status,
      terminal,
      error,
      ms: Date.now() - t0,
    });
    throw err;
  }
}

/**
 * Pauses before each verify read of a keyed write that ended unclear: reads at about 30 s, 3 min
 * and 10 min after the end. Platform lists lag, so one read at once proves little.
 */
export const VERIFY_PAUSES_MS: readonly number[] = [30_000, 150_000, 420_000];

/**
 * Least time between two verify reads of one key, per site. LinkedIn: one an hour, so repeated
 * asks never burst its post page (William, 10-30). A read too soon answers unknown, no read.
 */
export const VERIFY_GAP_MS: Readonly<Record<string, number>> = { linkedin: 3_600_000 };

/** What a keyed call's leg step settles to: the verdict, or only the verify reads are left. */
type Gate =
  | { end: SendVerdict }
  | {
      verify: SendRecord;
      /** This call ran the leg and it just ended: wait before the first read. Else read at once. */
      fresh: boolean;
    };

const notSent = (
  reason: string,
  how: "refused" | "before_submit" | "verified_absent",
  status?: number,
): SendVerdict => ({
  verdict: "not_sent",
  reason: reason.slice(0, 300),
  how,
  ...(status === undefined ? {} : { status }),
});

/** The facade's answer for a route with no leg to run (a browser flow nobody recorded). */
const NO_LEG = 501;

/** Why an answer with no submit step sent nothing: its own `reason`, else a plain one. */
export function unsentReasonOf(out: unknown): string {
  const r = (out as { reason?: unknown } | null)?.reason;
  return typeof r === "string" && r ? r : "the leg answered before any irreversible act";
}

/**
 * The 4xx `status` an answer with no submit step carries: the platform's standing no (comments
 * off, the post gone). The send is refused, so the caller drops it, not slots it again.
 */
export function unsentStatusOf(out: unknown): number | undefined {
  const s = (out as { status?: unknown } | null)?.status;
  return typeof s === "number" && s >= 400 && s < 500 ? s : undefined;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The status of a platform's refusal of a write: an HTTP 4xx, not a timeout (408). Else null. */
function refusalOf(err: unknown): number | null {
  // A SiteError after the submit is the site's own no read off the page (LinkedIn's weekly limit).
  return (err instanceof HttpError || err instanceof SiteError) &&
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 408
    ? err.status
    : null;
}

/**
 * `name`: `sites` on the box, `desk` on the Mac; one shape, two machines.
 * `calls`: every try of a call, one line each (`src/runs/calls.ts`).
 */
export function sitesService(
  facade: SiteFacade,
  name: string = SITES_SERVICE,
  calls?: SiteCalls,
  watchers?: Watchers | null,
  o: {
    /** How a call waits for a busy browser profile; the defaults when absent. */
    wait?: ProfileWait;
    /** What each keyed write left on this machine; in memory when absent (it forgets a restart). */
    journal?: SendJournal;
    /** Pauses before each verify read; `VERIFY_PAUSES_MS` when absent. */
    verifyPausesMs?: readonly number[];
    /** Least time between verify reads of one key, per site; `VERIFY_GAP_MS` when absent. */
    verifyGapMs?: Readonly<Record<string, number>>;
    /** The owner's API keys, for `keys`, `keySpend`, `keyRevoke` and `keyRotate`; 501 when absent. */
    keys?: KeyAdmin;
  } = {},
) {
  const journal = o.journal ?? memorySendJournal();
  const pauses = o.verifyPausesMs ?? VERIFY_PAUSES_MS;
  const gaps = o.verifyGapMs ?? VERIFY_GAP_MS;
  const keysHere = (): KeyAdmin => {
    if (!o.keys) throw new restate.TerminalError("no key vault here", { errorCode: 501 });
    return o.keys;
  };
  /** A `KeyError` is the caller's: its status, nothing else changed. */
  const keyCall = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof KeyError)
        throw new restate.TerminalError(err.message, { errorCode: err.status });
      throw err;
    }
  };
  const watching = () => {
    if (!watchers) throw new restate.TerminalError("no watchers here", { errorCode: 501 });
    return watchers;
  };
  /** A route with nothing declared: an unclear end of its write stays `unknown`. */
  const bare: SendSpec = { irreversible: true, parse: (_path, input) => input };
  const specOf = (req: z.infer<typeof call>): SendSpec => {
    try {
      return facade.sendSpec?.(req.site, req.method, req.path) ?? bare;
    } catch (err) {
      if (err instanceof SiteError)
        throw new restate.TerminalError(err.message, { errorCode: err.status });
      throw err;
    }
  };

  /** What the journal already says about a key. */
  const gateOf = (rec: SendRecord): Gate => {
    if (rec.verdict && isFinal(rec.verdict)) return { end: rec.verdict };
    if (journal.live(rec.key))
      return {
        end: { verdict: "unknown", reason: "the send is still running", since: rec.startedAt },
      };
    if (rec.submitted || rec.verdict) return { verify: rec, fresh: false };
    // Started, never submitted, and no call here is running it: its process died before the act.
    return {
      end: journal.settle(
        rec.key,
        notSent("an earlier try ended before its submit step", "before_submit"),
      ),
    };
  };

  /**
   * One keyed write: the leg runs at most once per key, behind the journal. Inside `ctx.run`.
   * It never throws except a request the site refuses outright (a SiteError under 500 before the
   * submit step) and a busy profile, which `waitForProfile` waits out.
   */
  async function sendLeg(
    req: z.infer<typeof call>,
    key: string,
    spec: SendSpec,
    run: (fn: () => Promise<unknown>) => Promise<unknown>,
    from: object,
  ): Promise<Gate> {
    const known = journal.get(key);
    if (known) return gateOf(known);
    journal.start({
      key,
      site: req.site,
      method: req.method,
      path: req.path,
      account: req.account ?? null,
      input: req.input,
    });
    journal.enter(key);
    // The key every guard below the facade reads (`currentCall`): one send key, one durable call.
    const t: CallTry = {
      key: `send ${key}`,
      submitted: false,
      onSubmit: () => journal.submitted(key),
    };
    try {
      const out = await run(() =>
        withCall(
          t.key,
          () => facade.call(req.site, req.method, req.path, req.input, req.account, from),
          t,
        ),
      );
      // An irreversible leg that answered with no act sent nothing (no post or comment found),
      // unless it said the thing was already there. With a 4xx status it never will.
      if (spec.irreversible && !t.submitted && !t.already) {
        const status = unsentStatusOf(out);
        return {
          end: journal.settle(
            key,
            notSent(unsentReasonOf(out), status ? "refused" : "before_submit", status),
          ),
        };
      }
      let ids: { id: string | null; url: string | null } = { id: null, url: null };
      try {
        ids = spec.sentAs?.(out) ?? ids;
      } catch {
        // The answer came; its id is a courtesy.
      }
      return {
        end: journal.settle(key, {
          verdict: "sent",
          ...ids,
          at: new Date().toISOString(),
          how: "answer",
          ...(out === undefined ? {} : { output: out }),
        }),
      };
    } catch (err) {
      // Nothing was asked of the site: forget the try, the wait runs it again.
      if (profileBusyOf(err)) {
        journal.forget(key);
        throw err;
      }
      const why = messageOf(err);
      if (!t.submitted) {
        // A request the site refuses outright: a bad body, no route, a cap's 429, or no leg
        // recorded (501, which the unkeyed call words `not sent: …`). Nothing was attempted.
        if (err instanceof SiteError && (err.status < 500 || err.status === NO_LEG)) {
          journal.forget(key);
          throw new restate.TerminalError(err.status < 500 ? why : sentWords(why, false), {
            errorCode: err.status,
            ...codeOf(err),
          });
        }
        return { end: journal.settle(key, notSent(why, "before_submit")) };
      }
      const status = refusalOf(err);
      if (status !== null) return { end: journal.settle(key, notSent(why, "refused", status)) };
      const rec = journal.get(key);
      if (!rec) return { end: journal.settle(key, notSent(why, "before_submit")) };
      return { verify: rec, fresh: true };
    } finally {
      journal.leave(key);
    }
  }

  /**
   * The verify reads of a write that ended unclear: each one `ctx.run`, a durable pause before
   * it. Found is `sent`, absent on a full read is `not_sent`, else `unknown`. The journal keeps it.
   */
  async function verifyReads(
    ctx: restate.Context,
    rec: SendRecord,
    spec: SendSpec,
    waits: readonly number[],
    from: object,
  ): Promise<SendVerdict> {
    const key = rec.key;
    const keep = (make: () => SendVerdict) =>
      ctx.run(`send ${key} verdict`, async () => journal.settle(key, make()));
    const unknown = (reason: string): SendVerdict => ({
      verdict: "unknown",
      reason: reason.slice(0, 300),
      since: rec.startedAt,
    });
    const v = spec.verify;
    if (!v) return keep(() => unknown("this route has no verify read"));
    if ("none" in v) return keep(() => unknown(v.none));
    let why = "no verify read ran";
    for (const [n, pause] of waits.entries()) {
      // A gap outlasts the pauses: one read per call at most.
      if (n > 0 && gaps[rec.site]) break;
      if (pause > 0) await ctx.sleep(pause);
      const seen = await ctx.run(
        `send ${key} verify read ${n + 1}`,
        async (): Promise<Seen | null> => {
          const gap = gaps[rec.site] ?? 0;
          const last = journal.get(key)?.readAt;
          if (gap && last && Date.now() - Date.parse(last) < gap) return null;
          journal.tried(key);
          try {
            const input = spec.parse(rec.path, rec.input);
            // The same account on the same site; another site (a signed-out one) has no account.
            const get: VerifyGet = (path, inp = {}, at) =>
              facade.call(
                at?.site ?? rec.site,
                at?.method ?? "GET",
                path,
                inp,
                at?.site && at.site !== rec.site ? null : rec.account,
                from,
              );
            const got = await v.read(input, get);
            return settle(got, {
              words: v.words(input),
              since: rec.startedAt,
              lags: v.lags?.(input) ?? null,
            });
          } catch (err) {
            return { seen: "unclear", why: `the verify read failed: ${messageOf(err)}` };
          }
        },
      );
      // Too soon: answer what is stored, no read.
      if (!seen)
        return ctx.run(
          `send ${key} stored`,
          async () =>
            journal.get(key)?.verdict ?? unknown(`${rec.site} reads a send at most once an hour`),
        );
      if (seen.seen === "found")
        return keep(() => ({
          verdict: "sent",
          id: seen.id,
          url: seen.url,
          at: seen.at ?? new Date().toISOString(),
          how: "verified",
        }));
      if (seen.seen === "absent")
        return keep(() =>
          notSent(
            "a full read of the account's recent items shows nothing sent",
            "verified_absent",
          ),
        );
      why = seen.why;
    }
    return keep(() => unknown(why));
  }

  /** A keyed write: the verdict is its result. */
  async function keyedCall(
    ctx: restate.Context,
    req: z.infer<typeof call>,
    key: string,
    from: object,
  ): Promise<SendVerdict> {
    const spec = specOf(req);
    const step = `sites ${req.site} ${req.method} ${req.path}`;
    const base = {
      service: name,
      site: req.site,
      route: `${req.method} ${req.path}`,
      ...(from as { caller: string | null; invocation: string }),
    };
    let attempt = 0;
    let gate: Gate;
    try {
      gate = await waitForProfile(
        ctx,
        step,
        () => sendLeg(req, key, spec, (fn) => recorded(calls, base, ++attempt, fn), from),
        // A write may take its profile from an explore session nobody is driving.
        { retry: WRITE_RETRY, take: true, ...(o.wait ? { wait: o.wait } : {}) },
      );
    } catch (err) {
      // A profile held past the bound: nothing was asked of the site.
      if (err instanceof restate.TerminalError && err.code === PROFILE_BUSY_STATUS)
        return await ctx.run(`send ${key} verdict`, async () =>
          journal.settle(key, notSent(err.message, "before_submit")),
        );
      throw err;
    }
    if ("end" in gate) return gate.end;
    return verifyReads(ctx, gate.verify, spec, gate.fresh ? pauses : [0, ...pauses.slice(1)], from);
  }

  return restate.service({
    name,
    handlers: {
      /** Lease (or renew) a tab watcher: `{site, account?, sink: {path, body}, until}`. */
      watch: async (ctx: restate.Context, raw: unknown) => {
        const w = watching();
        return ctx.run("watch", async () => {
          try {
            return await w.lease(raw);
          } catch (err) {
            if (err instanceof z.ZodError || /no watch spec/.test((err as Error).message))
              throw new restate.TerminalError((err as Error).message, { errorCode: 400 });
            throw err;
          }
        });
      },
      unwatch: async (ctx: restate.Context, raw: unknown) => {
        const { id } = parse(z.object({ id: z.string().min(1) }), raw);
        const w = watching();
        return ctx.run("unwatch", () => w.unwatch(id));
      },
      watches: async (ctx: restate.Context) => {
        const w = watching();
        return ctx.run("watches", () => w.states());
      },
      status: async (ctx: restate.Context, raw: unknown) => {
        const { site: which } = parse(site, raw);
        const step = `sites status ${which}`;
        return ctx.run(
          step,
          () => terminalOnSiteError(`${ctx.request().id} ${step}`, () => facade.status(which)),
          READ_RETRY,
        );
      },
      call: restate.handlers.handler(CALL_OPTS, async (ctx: restate.Context, raw: unknown) => {
        const req = parse(call, raw);
        const write = req.method !== "GET";
        const retry = write ? WRITE_RETRY : READ_RETRY;
        const from = {
          caller: req.caller ?? ctx.request().headers.get("x-caller") ?? null,
          invocation: ctx.request().id,
          ...(req.armId ? { armId: req.armId } : {}),
        };
        const step = `sites ${req.site} ${req.method} ${req.path}`;
        const base = {
          service: name,
          site: req.site,
          route: `${req.method} ${req.path}`,
          ...from,
        };
        if (write && req.until) {
          const until = req.until;
          const key = req.sendKey;
          // Only a write that never started: a started one is settled by its own record.
          const late = await ctx.run(
            `${step} until ${until}`,
            () => Date.now() > Date.parse(until) && !(key && journal.get(key)),
          );
          if (late) {
            const why = `missed its day: the desk ran it after ${until}`;
            if (key) return notSent(why, "before_submit");
            throw new restate.TerminalError(why, { errorCode: 410 });
          }
        }
        let attempt = 0;
        const once = async () => {
          if (write && req.sendKey) return await keyedCall(ctx, req, req.sendKey, from);
          return await waitForProfile(
            ctx,
            step,
            () =>
              recorded(calls, base, ++attempt, () =>
                terminalOnSiteError(
                  `${ctx.request().id} ${step}`,
                  () => facade.call(req.site, req.method, req.path, req.input, req.account, from),
                  // Writes run once; this bounds a read's retries.
                  write ? undefined : attempt,
                  write,
                ),
              ),
            // A write may take its profile from an explore session nobody is driving.
            { retry, take: write, ...(o.wait ? { wait: o.wait } : {}) },
          );
        };
        try {
          return await once();
        } catch (err) {
          // A refused token (409): its re-make starts now, not at tomorrow's renew.
          const claim = facade.claimRefused?.bind(facade);
          if (!claim || !(err instanceof restate.TerminalError) || err.code !== 409) throw err;
          const { queued, ours } = await ctx.run("refused tokens", async () => ({
            queued: await claim(),
            ours:
              ((await facade.refused?.()) ?? []).find(
                (r) =>
                  r.site === req.site && !r.gaveUp && err.message.includes(`${r.name} was refused`),
              ) ?? null,
          }));
          queueRemake(
            ctx,
            name,
            queued.filter((r) => r.name !== ours?.name),
          );
          // This call's own token: wait for its re-make, then try once more. A refresh token lost
          // to a rotation whose answer timed out (X, 10-16) costs a minute, not a failed post.
          if (!ours || !(await awaitRemake(ctx, name, ours))) throw err;
          return await once();
        }
      }),
      /**
       * What became of a keyed write, without calling it again: the journal's verdict. A write
       * that ended unclear is read again (at once, then the backoff). No record is `not_sent`.
       */
      verdict: restate.handlers.handler(CALL_OPTS, async (ctx: restate.Context, raw: unknown) => {
        const { sendKey } = parse(verdictReq, raw);
        const gate = await ctx.run(`send ${sendKey} gate`, async (): Promise<Gate> => {
          const rec = journal.get(sendKey);
          return rec ? gateOf(rec) : { end: notSent("no send under this key", "before_submit") };
        });
        if ("end" in gate) return gate.end;
        const from = {
          caller: ctx.request().headers.get("x-caller") ?? null,
          invocation: ctx.request().id,
        };
        // The route is read from the record; a stand-in facade without a spec has no verify read.
        const spec = specOf({
          site: gate.verify.site,
          method: gate.verify.method as z.infer<typeof call>["method"],
          path: gate.verify.path,
          input: gate.verify.input,
        });
        return verifyReads(ctx, gate.verify, spec, [0, ...pauses.slice(1)], from);
      }),
      /** The call's browser leg up to its last safe step, nothing sent: `{armed: id | null, until}`. */
      arm: async (ctx: restate.Context, raw: unknown) => {
        const req = parse(call, raw);
        const from = {
          caller: req.caller ?? ctx.request().headers.get("x-caller") ?? null,
          invocation: ctx.request().id,
          arm: true,
        };
        const step = `sites arm ${req.site} ${req.method} ${req.path}`;
        return waitForProfile(
          ctx,
          step,
          () =>
            terminalOnSiteError(`${ctx.request().id} ${step}`, () =>
              facade.call(req.site, req.method, req.path, req.input, req.account, from),
            ),
          { retry: WRITE_RETRY, ...(o.wait ? { wait: o.wait } : {}) },
        );
      },
      /** A day's capped reads: each bucket's use and every metered call, who asked, how it went. */
      caps: async (ctx: restate.Context, raw: unknown) => {
        const q = parse(
          z.object({
            day: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .optional(),
            site: z.string().min(1).optional(),
          }),
          raw ?? {},
        );
        return ctx.run(`sites caps ${q.day ?? "today"}`, () => facade.caps(q.day, q.site));
      },
      /** Make again what lapses within the window (a scheduler's daily call); lines say what happened. */
      renew: restate.handlers.handler(CALL_OPTS, async (ctx: restate.Context, raw: unknown) => {
        const { dry, names } = parse(renewReq, raw ?? {});
        if (!facade.renew)
          throw new restate.TerminalError("nothing lists what is kept here", { errorCode: 501 });
        const renew = facade.renew.bind(facade);
        const step = `sites renew${dry ? " (dry)" : ""}${names ? ` ${names.join(" ")}` : ""}`;
        // One try: a refused token's day is marked before its setup runs, so a rerun after a hung
        // consent page skips it, and two days of tries is the most it gets (`refused.ts`).
        return ctx.run(
          step,
          () =>
            withCall(`${ctx.request().id} ${step}`, () =>
              renew({ dry, ...(names ? { names } : {}) }),
            ),
          WRITE_RETRY,
        );
      }),
      /** End a grant at the site and queue the re-make of every token it covered: `{revoked}`. */
      revoke: async (ctx: restate.Context, raw: unknown) => {
        const req = parse(revoke, raw);
        const claim = facade.claimRefused?.bind(facade);
        if (!facade.revoke || !claim)
          throw new restate.TerminalError("no revoke here", { errorCode: 501 });
        const end = facade.revoke.bind(facade);
        const step = `sites revoke ${req.site}`;
        const out = await ctx.run(
          step,
          () =>
            terminalOnSiteError(`${ctx.request().id} ${step}`, async () => ({
              ...(await end(req.site, req.account ?? null)),
              queued: await claim(),
            })),
          WRITE_RETRY,
        );
        const ours = (r: { name: string }) => out.revoked.includes(r.name);
        queueRemake(ctx, name, out.queued.filter(ours), req.after * 60_000);
        queueRemake(
          ctx,
          name,
          out.queued.filter((r) => !ours(r)),
        );
        return { revoked: out.revoked, after: req.after };
      },
      /** The owner's API keys, no value in them: `{keys: KeyRow[]}`. Revoked ones only with `all`. */
      keys: async (ctx: restate.Context, raw: unknown): Promise<{ keys: KeyRow[] }> => {
        const q = parse(keysRequest, raw ?? {});
        const admin = keysHere();
        return ctx.run(
          "sites keys",
          () => keyCall(async () => ({ keys: await admin.list(q) })),
          READ_RETRY,
        );
      },
      /** Mark a key out of credit until a date, re-project its vendor: the key's row. */
      keySpend: async (ctx: restate.Context, raw: unknown): Promise<KeyRow> => {
        const req = parse(keySpendRequest, raw);
        const admin = keysHere();
        return ctx.run(
          "sites keySpend",
          () => keyCall(() => admin.spend(req.address, req.until)),
          WRITE_RETRY,
        );
      },
      /** Take a key out of use here for good, re-project its vendor: the row and the env names changed. */
      keyRevoke: async (ctx: restate.Context, raw: unknown): Promise<KeyRevokeAnswer> => {
        const req = parse(keyRevokeRequest, raw);
        const admin = keysHere();
        return ctx.run(
          "sites keyRevoke",
          () => keyCall(() => admin.revoke(req.address)),
          WRITE_RETRY,
        );
      },
      /**
       * Start the vendor's mint flow as a run that replaces this key. The run's own gate asks before
       * the key is made. The key is the day's: asking twice in a day is the same run.
       */
      keyRotate: async (ctx: restate.Context, raw: unknown): Promise<KeyRotateAnswer> => {
        const req = parse(keyRotateRequest, raw);
        const admin = keysHere();
        const rotation = await ctx.run(
          "sites keyRotate",
          () => keyCall(() => admin.rotation(req.address)),
          READ_RETRY,
        );
        ctx
          .objectSendClient<RunObject<AnyWorkflow>>(
            { name: named(COMPILED_OBJECT.name, admin.owner) },
            compiledKey(rotation.workflow, rotation.key),
          )
          .run(
            { ...rotation.plan, dryRun: false } as never,
            restate.rpc.sendOpts({ idempotencyKey: `${rotation.workflow}/${rotation.key}` }),
          );
        return { run: compiledKey(rotation.workflow, rotation.key), workflow: rotation.workflow };
      },
      setup: async (ctx: restate.Context, raw: unknown) => {
        const req = parse(setup, raw);
        const step = `sites setup ${req.site} ${req.step}`;
        return waitForProfile(
          ctx,
          step,
          () =>
            terminalOnSiteError(`${ctx.request().id} ${step}`, () =>
              facade.setup(req.site, req.step, req.account),
            ),
          { retry: WRITE_RETRY, ...(o.wait ? { wait: o.wait } : {}) },
        );
      },
    },
  });
}
export type SitesService = ReturnType<typeof sitesService>;
