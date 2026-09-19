/**
 * A browser flow is a typed function over a logged-in page: input in,
 * result out, `NeedsHuman` when a person must step in. The runner around
 * it is the same for every flow: one session per run, one flow per site at
 * a time (a profile cannot be open twice), a Playwright trace of every run
 * that goes wrong, a screenshot on the way out. A step that runs a flow
 * still proves the result through an API read afterwards where one exists;
 * the trace is for the person, the API read is for the machine.
 *
 * Flows are transcribed from recordings (`autobrowse record <site> --flow
 * <name>` runs Playwright codegen on the site's profile). The recording is
 * raw and may hold typed secrets; it stays out of git. What goes in is the
 * typed flow with visible-label selectors, so a redesign fails loudly.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { expandHome } from "../google-auth.js";
import { type Hints, locate } from "./locate.js";
import { KeyedMutex } from "./lock.js";
import { canLearn, noRepairer, type Repairer, type RepairReport, snapshotPage } from "./repair.js";
import { type BrowserOptions, looksLikeWall, NeedsHuman, openSession } from "./session.js";

/** A site names a persistent profile; any kebab-case string. Known ones have a home page for `login`. */
export type Site = string;

export const SITES: Record<string, { home: string }> = {
  cloudflare: { home: "https://dash.cloudflare.com/" },
  "google-admin": { home: "https://admin.google.com/" },
  instantly: { home: "https://app.instantly.ai/" },
};

/** One recorded gesture, replayed. */
export type Op =
  | { kind: "click" }
  | { kind: "fill"; value: string }
  | { kind: "select"; value: string }
  | { kind: "press"; key: string };

export interface ActOptions {
  /** In words, for the repairer and the trace: "click Purchase". */
  goal: string;
  /** Never repaired: a miss goes to a person. */
  irreversible?: boolean;
  timeoutMs?: number;
}

/** What a flow body gets: the page, plus the things every flow does. */
export interface OpenOptions {
  /** Land on a login page on purpose (the sign-in flow itself). */
  allowWall?: boolean;
}

export interface FlowPage {
  page: Page;
  /**
   * Navigate. On a login wall the runner signs in with stored credentials
   * and tries again; a captcha, or a site nobody has credentials for,
   * goes to a person.
   */
  open(url: string, opts?: OpenOptions): Promise<void>;
  url(): string;
  /** Visible text of the page, capped; what a person would read. */
  text(): Promise<string>;
  /** Raw markup, capped; for things the eye cannot see (an otpauth link behind a QR). */
  html(): Promise<string>;
  /** Whether something matching `hints` is on the page right now. */
  has(hints: Hints): Promise<boolean>;
  wait(ms: number): Promise<void>;
  /**
   * Find by hints and do the op. On a miss, ask the repairer for other
   * hints for the same goal and try once more; report the repair either way.
   */
  act(op: Op, hints: Hints, opts: ActOptions): Promise<void>;
  /** Stop here and ask a person. */
  human(reason: string): never;
}

export interface BrowserFlow<I, O> {
  site: Site;
  /** Unique per site; names the trace files and the fake in tests. */
  name: string;
  run(fp: FlowPage, input: I): Promise<O>;
}

export function defineFlow<I, O>(flow: BrowserFlow<I, O>): BrowserFlow<I, O> {
  return flow;
}

export interface FlowRunner {
  run<I, O>(flow: BrowserFlow<I, O>, input: I): Promise<O>;
}

/**
 * The browser leg broke under the flow (Chrome died, the network went
 * away, the CDP socket closed). Nothing about the site or the flow is
 * wrong, so the host retries the whole flow with a fresh session.
 */
export class FlowInterrupted extends Error {
  constructor(
    flow: string,
    cause: unknown,
    readonly artifacts: { screenshot?: string; trace?: string },
  ) {
    super(`${flow}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "FlowInterrupted";
  }
}

const TRANSIENT =
  /target (page|context|browser) has been closed|browser has been closed|target closed|connection closed|websocket|socket hang up|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|CONNECTION_(RESET|CLOSED|REFUSED)|NAME_NOT_RESOLVED|TIMED_OUT|ADDRESS_UNREACHABLE)|browser process (crashed|exited)|Protocol error.*(Target|Session) closed/i;

/** Sleep, a dropped network, a crashed or closed browser: retry, do not fail. */
export function isTransientBrowserError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return TRANSIENT.test(msg);
}

/** A flow threw something other than NeedsHuman; the artifacts say where. */
export class FlowFailed extends Error {
  constructor(
    flow: string,
    cause: unknown,
    readonly artifacts: { screenshot?: string; trace?: string },
  ) {
    super(`${flow}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "FlowFailed";
  }
}

export interface RunnerOptions {
  repairer?: Repairer;
  /**
   * Solves a login wall for a site: "signed-in" to retry the open,
   * anything else to hand off. Absent = every wall is a person's.
   */
  login?: (fp: FlowPage, site: Site) => Promise<"signed-in" | "no-credential" | "unknown-site">;
  /** Repair misses on irreversible acts too (the `irreversible` guard is off). */
  repairIrreversible?: boolean;
  /** Every repair, tried or not, so the flow's source can be fixed for good. */
  onRepair?: (report: RepairReport) => void;
  locks?: KeyedMutex;
}

const ACT_TIMEOUT_MS = 15_000;
const SETTLE_MS = 8_000;

/**
 * Navigate and let client-side redirects finish: a dashboard that bounces
 * to its login page does so after DOMContentLoaded, and a wall check
 * before that would call an unauthenticated page "signed in".
 */
async function settle(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => undefined);
}

async function doOp(page: Page, hints: Hints, op: Op, timeout: number): Promise<void> {
  const target = locate(page, hints);
  switch (op.kind) {
    case "click":
      return target.click({ timeout });
    case "fill":
      return target.fill(op.value, { timeout });
    case "select":
      return void (await target.selectOption(op.value, { timeout }));
    case "press":
      return target.press(op.key, { timeout });
  }
}

export function flowRunner(opts: BrowserOptions, runner: RunnerOptions = {}): FlowRunner {
  const artifactsDir = expandHome(opts.artifactsDir);
  const locks = runner.locks ?? new KeyedMutex();
  const repairer = runner.repairer ?? noRepairer;
  return {
    run: (flow, input) =>
      locks.withLock(flow.site, async () => {
        // Opening the browser is the first thing the network or the machine can break.
        const session = await openSession(flow.site, opts).catch((err: unknown) => {
          if (isTransientBrowserError(err))
            throw new FlowInterrupted(`${flow.site}/${flow.name}`, err, {});
          throw err;
        });
        const stamp = `${flow.site}-${flow.name}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        mkdirSync(artifactsDir, { recursive: true });
        // Tracing is best effort: a CDP-attached context may refuse it.
        const tracing = await session.context.tracing
          .start({ screenshots: true, snapshots: true })
          .then(() => true)
          .catch(() => false);
        let signingIn = false;
        const fp: FlowPage = {
          page: session.page,
          async open(url, o = {}) {
            await settle(session.page, url);
            if (o.allowWall) return;
            const wall = await looksLikeWall(session.page);
            if (!wall) return;
            if (wall.kind === "captcha" || !runner.login || signingIn)
              throw new NeedsHuman(`${flow.site}: ${wall.detail}`);
            signingIn = true;
            try {
              const outcome = await runner.login(fp, flow.site);
              if (outcome !== "signed-in")
                throw new NeedsHuman(`${flow.site}: ${wall.detail} (${outcome})`);
            } finally {
              signingIn = false;
            }
            await settle(session.page, url);
            const again = await looksLikeWall(session.page);
            if (again) throw new NeedsHuman(`${flow.site}: ${again.detail} after signing in`);
          },
          url: () => session.page.url(),
          text: async () =>
            (
              await session.page
                .locator("body")
                .innerText()
                .catch(() => "")
            ).slice(0, 20_000),
          html: async () => (await session.page.content().catch(() => "")).slice(0, 400_000),
          has: (hints) =>
            locate(session.page, hints)
              .first()
              .isVisible()
              .catch(() => false),
          wait: (ms) => session.page.waitForTimeout(ms),
          async act(op, hints, a) {
            const timeout = a.timeoutMs ?? ACT_TIMEOUT_MS;
            const page = session.page;
            try {
              await doOp(page, hints, op, timeout);
              return;
            } catch (err) {
              if (a.irreversible && !runner.repairIrreversible)
                throw new NeedsHuman(`${flow.site}: ${a.goal} (irreversible, not repaired)`);
              const proposal = await repairer.propose({
                site: flow.site,
                goal: a.goal,
                failed: hints,
                url: page.url(),
                snapshot: await snapshotPage(page),
              });
              if (!proposal) throw err;
              const report: RepairReport = {
                ...proposal,
                site: flow.site,
                flow: `${flow.site}/${flow.name}`,
                goal: a.goal,
                failed: hints,
                url: page.url(),
                ok: false,
              };
              try {
                await doOp(page, proposal.hints, op, timeout);
                report.ok = true;
              } finally {
                runner.onRepair?.(report);
                if (canLearn(repairer)) await repairer.learn(report);
              }
            }
          },
          human(reason) {
            throw new NeedsHuman(`${flow.site}: ${reason}`);
          },
        };
        try {
          return await flow.run(fp, input);
        } catch (err) {
          const artifacts: { screenshot?: string; trace?: string } = {};
          const shot = join(artifactsDir, `${stamp}.png`);
          if (
            await session.page.screenshot({ path: shot, fullPage: true }).then(
              () => true,
              () => false,
            )
          )
            artifacts.screenshot = shot;
          if (tracing) {
            const trace = join(artifactsDir, `${stamp}.zip`);
            if (
              await session.context.tracing.stop({ path: trace }).then(
                () => true,
                () => false,
              )
            )
              artifacts.trace = trace;
          }
          if (err instanceof NeedsHuman) {
            err.artifacts = artifacts;
            throw err;
          }
          if (isTransientBrowserError(err))
            throw new FlowInterrupted(`${flow.site}/${flow.name}`, err, artifacts);
          throw new FlowFailed(`${flow.site}/${flow.name}`, err, artifacts);
        } finally {
          if (tracing) await session.context.tracing.stop().catch(() => undefined);
          await session.close();
        }
      }),
  };
}
