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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { expandHome } from "../google-auth.js";
import { redactAria, redactText } from "../recorder/redact.js";
import { type Hands, HUMAN_PACE, handsFor, type Pace } from "./human/index.js";
import { type Hints, locate, textOf } from "./locate.js";
import { KeyedMutex } from "./lock.js";
import { canLearn, noRepairer, type Repairer, type RepairReport, snapshotPage } from "./repair.js";
import {
  type Artifacts,
  type BrowserOptions,
  bodyText,
  type FailureRecord,
  looksLikeWall,
  NeedsHuman,
  openSession,
  pageHtml,
} from "./session.js";
import type { Passkeys } from "./webauthn.js";

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
  | { kind: "press"; key: string }
  /** Files into a file input, or through the chooser a button opens. */
  | { kind: "upload"; files: string[] };

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
  /** The session's virtual authenticator: export after a passkey enrollment. */
  passkeys: Passkeys;
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
  /** Visible now, or within `withinMs` when given (a page still rendering its next step). */
  has(hints: Hints, withinMs?: number): Promise<boolean>;
  /** The element's text, trimmed and capped: what a scraping step keeps. */
  read(hints: Hints): Promise<string>;
  wait(ms: number): Promise<void>;
  /** Resolves when the URL matches, or null at the timeout. */
  waitForUrl(pattern: RegExp | ((url: string) => boolean), timeoutMs: number): Promise<boolean>;
  /** The next page the site opens (an OAuth popup), or null when none comes in time. */
  nextPage(timeoutMs: number): Promise<Page | null>;
  /** Every page open right now: a card that opened itself is already here, so no event comes. */
  pages(): Page[];
  /** Act on this page from now on (a popup); pass the main page to return. */
  switchTo(page: Page): void;
  /**
   * Find by hints and do the op. On a miss, ask the repairer for other
   * hints for the same goal and try once more; report the repair either way.
   */
  act(op: Op, hints: Hints, opts: ActOptions): Promise<void>;
  /**
   * Answer a wall the flow walked into on its own (a re-verification in
   * the middle of an OAuth consent): the runner signs in where the page
   * is, with no navigation to lose the URL that carries the walk.
   */
  signIn(
    site?: Site,
    account?: string,
  ): Promise<"signed-in" | "no-credential" | "unknown-site" | "no-login">;
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
    readonly artifacts: Artifacts,
  ) {
    super(`${flow}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "FlowInterrupted";
  }
}

const TRANSIENT =
  /target (page|context|browser) has been closed|browser has been closed|target closed|connection closed|websocket|socket hang up|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|CONNECTION_(RESET|CLOSED|REFUSED)|NAME_NOT_RESOLVED|TIMED_OUT|ADDRESS_UNREACHABLE)|browser process (crashed|exited)|Protocol error.*(Target|Session) closed/i;

/** Sleep, a dropped network, a crashed or closed browser: retry, do not fail. */
/** Chrome's own error page (no internet, DNS gone): the leg is down, whatever the flow was doing. */
const OFFLINE_PAGE = /^chrome-error:\/\//;

export function isTransientBrowserError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return TRANSIENT.test(msg);
}

/** A flow threw something other than NeedsHuman; the artifacts say where. */
export class FlowFailed extends Error {
  constructor(
    flow: string,
    cause: unknown,
    readonly artifacts: Artifacts,
  ) {
    super(`${flow}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "FlowFailed";
  }
}

export interface RunnerOptions {
  repairer?: Repairer;
  /**
   * How a person's hands would do each act (`browser/human`): a pause to
   * read, a curved reach, typing in runs. On by default; null is instant
   * (tests, demos).
   */
  pace?: Pace | null;
  /**
   * Solves a login wall for a site: "signed-in" to retry the open,
   * anything else to hand off. Absent = every wall is a person's.
   */
  login?: (
    fp: FlowPage,
    site: Site,
    /** Whose sign-in it is, when the caller knows: picks the `<site>@<label>` credential for it. */
    account?: string,
  ) => Promise<"signed-in" | "no-credential" | "unknown-site">;
  /** Repair misses on irreversible acts too (the `irreversible` guard is off). */
  repairIrreversible?: boolean;
  /** Every repair, tried or not, so the flow's source can be fixed for good. */
  onRepair?: (report: RepairReport) => void;
  /** Every failure record written (kind failed/human/interrupted): what healing starts from. */
  onFailure?: (record: FailureRecord, file: string) => void;
  locks?: KeyedMutex;
}

const ACT_TIMEOUT_MS = 15_000;

const SETTLE_MS = 8_000;
/** AWS's console → sign-in chain takes 30–60 s to DOMContentLoaded headless; Playwright's 30 s default cut it. */
const NAVIGATE_MS = 90_000;

/**
 * Navigate and let client-side redirects finish: a dashboard that bounces
 * to its login page does so after DOMContentLoaded, and a wall check
 * before that would call an unauthenticated page "signed in".
 */
async function settle(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATE_MS });
  await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => undefined);
}

/**
 * Choose a value on a `<select>`, or on a custom dropdown (a combobox/button
 * that opens a list): open it, then click the option whose text is the value.
 * The step stays a `select` either way, so a recording replays the same.
 */
export async function chooseOption(
  page: Page,
  target: Locator,
  value: string,
  timeout: number,
): Promise<void> {
  try {
    await target.selectOption(value, { timeout });
    return;
  } catch (err) {
    if (!/not a <select>/i.test(String(err))) throw err;
  }
  await target.click({ timeout });
  const option = page
    .getByRole("option", { name: value, exact: true })
    .or(page.getByRole("menuitem", { name: value, exact: true }))
    .or(page.getByRole("menuitemradio", { name: value, exact: true }))
    .first();
  const shown = await option
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
  if (shown) return option.click({ timeout });
  // A list with no roles: the first visible element whose whole text is the value.
  await page.getByText(value, { exact: true }).locator("visible=true").first().click({ timeout });
}

async function doOp(
  page: Page,
  hints: Hints,
  op: Op,
  timeout: number,
  hands: Hands,
): Promise<void> {
  const target = locate(page, hints);
  await hands.think(page);
  switch (op.kind) {
    case "click":
      return hands.click(target, { timeout });
    case "fill":
      return hands.type(target, op.value, { timeout });
    case "select":
      return chooseOption(page, target, op.value, timeout);
    case "press":
      return hands.press(target, op.key, { timeout });
    case "upload": {
      const isInput = await target
        .evaluate(
          (el) => el.tagName === "INPUT" && (el as { type?: string }).type === "file",
          undefined,
          { timeout },
        )
        .catch(() => false);
      if (isInput) return target.setInputFiles(op.files, { timeout });
      const chooser = page.waitForEvent("filechooser", { timeout });
      await hands.click(target, { timeout });
      return (await chooser).setFiles(op.files);
    }
  }
}

export function flowRunner(opts: BrowserOptions, runner: RunnerOptions = {}): FlowRunner {
  const artifactsDir = expandHome(opts.artifactsDir);
  const locks = runner.locks ?? new KeyedMutex();
  const repairer = runner.repairer ?? noRepairer;
  const hands = handsFor(runner.pace === undefined ? HUMAN_PACE : runner.pace);
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
        let lastGoal: string | null = null;
        mkdirSync(artifactsDir, { recursive: true });
        // Tracing is best effort: a CDP-attached context may refuse it.
        const tracing = await session.context.tracing
          .start({ screenshots: true, snapshots: true })
          .then(() => true)
          .catch(() => false);
        let signingIn = false;
        let active = session.page;
        const fp: FlowPage = {
          get page() {
            return active;
          },
          async open(url, o = {}) {
            active = session.page;
            await settle(session.page, url);
            if (OFFLINE_PAGE.test(session.page.url()))
              throw new Error(`net::ERR_INTERNET_DISCONNECTED opening ${url}`);
            if (o.allowWall) return;
            // Twice: a security page asks for the password again right after a sign-in.
            for (let attempt = 1; ; attempt++) {
              const wall = await looksLikeWall(session.page);
              if (!wall) return;
              const after = attempt > 1 ? " after signing in" : "";
              if (wall.kind === "captcha" || !runner.login || signingIn || attempt > 2)
                throw new NeedsHuman(`${flow.site}: ${wall.detail}${after}`);
              signingIn = true;
              try {
                const outcome = await runner.login(fp, flow.site);
                if (outcome !== "signed-in")
                  throw new NeedsHuman(`${flow.site}: ${wall.detail} (${outcome})`);
              } finally {
                signingIn = false;
              }
              await settle(session.page, url);
            }
          },
          url: () => active.url(),
          text: () => bodyText(active, 20_000),
          html: () => pageHtml(active, 400_000),
          has: (hints, withinMs = 0) =>
            withinMs > 0
              ? locate(active, hints)
                  .first()
                  .waitFor({ state: "visible", timeout: withinMs })
                  .then(
                    () => true,
                    () => false,
                  )
              : locate(active, hints)
                  .first()
                  .isVisible()
                  .catch(() => false),
          read: async (hints) => (await textOf(locate(active, hints))).slice(0, 2_000),
          wait: (ms) => active.waitForTimeout(ms),
          waitForUrl: (pattern, timeout) =>
            active
              .waitForURL(pattern instanceof RegExp ? pattern : (u) => pattern(u.toString()), {
                timeout,
              })
              .then(
                () => true,
                () => false,
              ),
          nextPage: (timeout) =>
            session.context.waitForEvent("page", { timeout }).catch(() => null),
          pages: () => session.context.pages(),
          switchTo(page) {
            active = page;
          },
          async act(op, hints, a) {
            lastGoal = a.goal;
            const timeout = a.timeoutMs ?? ACT_TIMEOUT_MS;
            const page = active;
            try {
              await doOp(page, hints, op, timeout, hands);
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
                await doOp(page, proposal.hints, op, timeout, hands);
                report.ok = true;
              } finally {
                runner.onRepair?.(report);
                if (canLearn(repairer)) await repairer.learn(report);
              }
            }
          },
          async signIn(site, account) {
            if (!runner.login || signingIn) return "no-login";
            signingIn = true;
            try {
              return await runner.login(fp, site ?? flow.site, account);
            } finally {
              signingIn = false;
            }
          },
          human(reason) {
            throw new NeedsHuman(`${flow.site}: ${reason}`);
          },
          passkeys: session.passkeys,
        };
        try {
          return await flow.run(fp, input);
        } catch (err) {
          const artifacts: Artifacts = {};
          const shot = join(artifactsDir, `${stamp}.png`);
          if (
            await session.page.screenshot({ path: shot, fullPage: true }).then(
              () => true,
              () => false,
            )
          )
            artifacts.screenshot = shot;
          // The accessibility tree next to the PNG: a reader (or a model)
          // sees every control by role and name without opening the image.
          const aria = join(artifactsDir, `${stamp}.aria.txt`);
          const tree = await session.page
            .locator("body")
            .ariaSnapshot({ timeout: 5_000 })
            .catch(() => null);
          if (tree !== null) {
            writeFileSync(aria, redactAria(`${session.page.url()}\n\n${tree}`));
            artifacts.aria = aria;
          }
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
          const kind: FailureRecord["kind"] =
            err instanceof NeedsHuman
              ? "human"
              : isTransientBrowserError(err) || OFFLINE_PAGE.test(active.url())
                ? "interrupted"
                : "failed";
          // The failure as data: `autobrowse repair <this file>` hands it to the agent.
          const record: FailureRecord = {
            site: flow.site,
            flow: flow.name,
            url: active.url(),
            goal: lastGoal,
            error: redactText(err instanceof Error ? err.message : String(err)),
            kind,
            at: new Date().toISOString(),
            ...(artifacts.screenshot ? { screenshot: artifacts.screenshot } : {}),
            ...(artifacts.aria ? { aria: artifacts.aria } : {}),
          };
          artifacts.failure = join(artifactsDir, `${stamp}.failure.json`);
          writeFileSync(artifacts.failure, JSON.stringify(record, null, 2));
          runner.onFailure?.(record, artifacts.failure);
          if (err instanceof NeedsHuman) {
            err.artifacts = artifacts;
            throw err;
          }
          if (kind === "interrupted")
            throw new FlowInterrupted(`${flow.site}/${flow.name}`, err, artifacts);
          throw new FlowFailed(`${flow.site}/${flow.name}`, err, artifacts);
        } finally {
          if (tracing) await session.context.tracing.stop().catch(() => undefined);
          await session.close();
        }
      }),
  };
}
