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
import type { FileChooser, Locator, Page } from "playwright";
import { expandHome } from "../google-auth.js";
import { redactAria, redactText } from "../recorder/redact.js";
import { currentCall, type DoneActs } from "./attempt.js";
import { type CaptchaOutcome, type Eyes, solveCaptcha } from "./captcha/index.js";
import { type Fixes, flowKey } from "./fixes.js";
import { type Hands, HUMAN_PACE, handsFor, instantHands, type Pace } from "./human/index.js";
import { type Hints, locate, textOf } from "./locate.js";
import { KeyedMutex } from "./lock.js";
import { describePage } from "./page-state.js";
import type { SessionPark } from "./park.js";
import {
  COMMITTING,
  canLearn,
  noRepairer,
  type Repairer,
  type RepairReport,
  snapshotPage,
} from "./repair.js";
import {
  INTERRUPTS,
  isOn,
  keepOf,
  type LearnedScreens,
  lookAt,
  memoryScreens,
  type PageLook,
  type Screen,
  type ScreenHelp,
  type ScreenReader,
} from "./screens.js";
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
import { type Watch, watches, watchSteps } from "./watch.js";
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
  /**
   * Answer requests under `prefix` in the browser itself (an OAuth redirect
   * nothing serves), so the page lands there and its URL keeps the query.
   */
  answer(prefix: string, body: string): Promise<void>;
  /** Resolves when the URL matches, or null at the timeout. */
  waitForUrl(pattern: RegExp | ((url: string) => boolean), timeoutMs: number): Promise<boolean>;
  /** The next page the site opens (an OAuth popup), or null when none comes in time. */
  nextPage(timeoutMs: number): Promise<Page | null>;
  /** Move the page down about `dy` px with the runner's hands (a feed read). */
  scroll(dy: number): Promise<void>;
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
  /**
   * Solve the captcha the page shows with the runner's hands and eyes
   * (`browser/captcha`): a checkbox always, a picture one when the runner
   * has eyes. Never throws for an unsolved one; the outcome says why.
   */
  captcha(): Promise<CaptchaOutcome>;
  /** Stop here and ask a person. */
  human(reason: string): never;
  /** What a screens walk asks of the runner: the page's shape, learned screens, a model (`browser/screens`). */
  screens?: ScreenHelp;
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
  /**
   * A captcha wall is solved before it goes to a person: checkboxes by the
   * hands alone, pictures when `eyes` is given (a model that sees). Absent =
   * every captcha is a person's. `attempts` whole solves before that
   * (`CAPTCHA_ATTEMPTS`, default 3; 0 = straight to a person).
   */
  captcha?: { eyes: Eyes | null; attempts?: number };
  /** Repair misses on irreversible acts too (the `irreversible` guard is off). */
  repairIrreversible?: boolean;
  /** Every repair, tried or not, so the flow's source can be fixed for good. */
  onRepair?: (report: RepairReport) => void;
  /** Repairs that worked, tried before the source's own hints on the next run (`browser/fixes`). */
  fixes?: Fixes;
  /** Pages seen before on each site and what worked on them: walks' screens, clicks past interrupts (`browser/screens`). */
  learnedScreens?: LearnedScreens;
  /** Names a page a walk does not know, from the walk's own screens. Absent = such a page fails the walk. */
  screenReader?: ScreenReader | null;
  /** Irreversible acts a durable call already did: a retry never does them twice (`browser/attempt`). */
  done?: DoneActs;
  /** Every failure record written (kind failed/human/interrupted): what healing starts from. */
  onFailure?: (record: FailureRecord, file: string) => void;
  locks?: KeyedMutex;
  /**
   * Keep each run's browser for the next run on the same site instead of
   * closing it: a gate or a hand-off between two steps keeps the page.
   * Only for a long-lived worker; a one-shot CLI would never exit.
   */
  park?: SessionPark;
  /**
   * The flows to watch step by step (`WATCH_FLOWS`: `all`, a site, or
   * `site/flow`, comma separated): a masked screenshot and the aria tree per
   * step, and the trace kept even when the run works (`browser/watch`).
   */
  watch?: string;
}

const ACT_TIMEOUT_MS = 15_000;
/** How often a step waiting for its control looks for something in the way. */
const POLL_MS = 250;
/** Clicks past what is in the way before one act gives up: a new screen or two, not a new flow. */
const MAX_DETOURS = 3;

/** The same page, fragment aside. */
function samePage(current: string, url: string): boolean {
  const strip = (u: string) => u.replace(/#.*$/, "").replace(/\/$/, "");
  return strip(current) === strip(url);
}

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
  hands: Hands = instantHands,
): Promise<void> {
  try {
    await target.selectOption(value, { timeout });
    return;
  } catch (err) {
    if (!/not a <select>/i.test(String(err))) throw err;
  }
  await hands.click(target, { timeout });
  const option = page
    .getByRole("option", { name: value, exact: true })
    .or(page.getByRole("menuitem", { name: value, exact: true }))
    .or(page.getByRole("menuitemradio", { name: value, exact: true }))
    .first();
  const shown = await option
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
  if (shown) return hands.click(option, { timeout });
  // A list with no roles: the first visible element whose whole text is the value.
  await hands.click(page.getByText(value, { exact: true }).locator("visible=true").first(), {
    timeout,
  });
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
      return chooseOption(page, target, op.value, timeout, hands);
    case "press":
      return hands.press(target, op.key, { timeout });
    case "upload": {
      // A ref from another machine (s3://, a signed URL) becomes a temp file for this act.
      const { localCopies } = await import("./run-files.js");
      const local = await localCopies(op.files);
      try {
        return await uploadFiles(page, target, local.paths, timeout, hands);
      } finally {
        await local.done();
      }
    }
  }
}

/** Files into a file input, else through the chooser the target opens. */
async function uploadFiles(
  page: Page,
  target: Locator,
  files: string[],
  timeout: number,
  hands: Hands,
): Promise<void> {
  const isInput = await target
    .evaluate(
      (el) => el.tagName === "INPUT" && (el as { type?: string }).type === "file",
      undefined,
      { timeout },
    )
    .catch(() => false);
  if (isInput) return target.setInputFiles(files, { timeout });
  // Caught here: a click that throws must not leave the wait to reject unhandled.
  const chooser = page.waitForEvent("filechooser", { timeout }).catch((e: unknown) => e);
  await hands.click(target, { timeout });
  const got = await chooser;
  if (!(got instanceof Error)) return (got as FileChooser).setFiles(files);
  // Some buttons open no chooser (YouTube Studio): their hidden input sits beside them.
  const near = target
    .locator("xpath=ancestor-or-self::*[.//input[@type='file']][1]//input[@type='file']")
    .first();
  if (await near.count()) return near.setInputFiles(files, { timeout });
  throw got;
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
        const parked = (await runner.park?.take(flow.site)) ?? null;
        const session =
          parked ??
          (await openSession(flow.site, opts).catch((err: unknown) => {
            if (isTransientBrowserError(err))
              throw new FlowInterrupted(`${flow.site}/${flow.name}`, err, {});
            throw err;
          }));
        // A kept browser already on the page the flow opens first stays put:
        // reloading would lose what the last run left there (a form, a list).
        let keepPage = parked !== null;
        let broken = false;
        const stamp = `${flow.site}-${flow.name}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        let lastGoal: string | null = null;
        const call = currentCall();
        // What the last act or read looked for: a heal finds the one op that broke by it.
        let lastHints: Hints | null = null;
        let acts = 0;
        let actsBefore = 0;
        mkdirSync(artifactsDir, { recursive: true });
        // Tracing is best effort: a CDP-attached context may refuse it. Never
        // in the person's own browser: it would film their other tabs.
        const tracing =
          !session.shared &&
          (await session.context.tracing
            .start({ screenshots: true, snapshots: true })
            .then(() => true)
            .catch(() => false));
        let signingIn = false;
        let triedCaptcha = false;
        let active = session.page;
        const learned = runner.learnedScreens ?? memoryScreens();
        const help: ScreenHelp = {
          look: () => lookAt(active),
          snapshot: () => snapshotPage(active),
          learned,
          reader: runner.screenReader ?? null,
        };
        // The URL whose overlays were last looked for: once per page, not per act.
        let overlaysAt: string | null = null;
        const watch: Watch | null = watches(runner.watch ?? opts.watchFlows, flow.site, flow.name)
          ? watchSteps(join(artifactsDir, stamp))
          : null;
        const stepped = <T>(
          s: Parameters<Watch["step"]>[0],
          run: () => Promise<T>,
          outcome?: (r: T) => "ok" | "repaired" | "failed",
        ): Promise<T> => (watch ? watch.step(s, () => active, run, outcome) : run());
        const fp: FlowPage = {
          get page() {
            return active;
          },
          open: (url, o = {}) =>
            stepped({ kind: "open", goal: `open ${url}` }, () => openPage(url, o)),
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
          read: async (hints) => {
            lastHints = hints;
            actsBefore = acts++;
            return (await textOf(locate(active, hints))).slice(0, 2_000);
          },
          wait: (ms) => active.waitForTimeout(ms),
          answer: (prefix, body) =>
            session.context
              .route(
                (u) => u.toString().startsWith(prefix),
                (r) => r.fulfill({ status: 200, contentType: "text/plain", body }),
              )
              .then(() => {}),
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
          scroll: (dy) => hands.scroll(active, dy),
          pages: () => session.context.pages(),
          switchTo(page) {
            active = page;
          },
          async act(op, hints, a) {
            lastGoal = a.goal;
            lastHints = hints;
            actsBefore = acts++;
            // Kept after the flow succeeds too: a step that runs two flows replays the first when the second breaks.
            const once =
              a.irreversible && call && runner.done
                ? `${flow.site}/${flow.name} ${actsBefore} ${a.goal}`
                : null;
            if (once && runner.done?.has(call as string, once))
              throw new NeedsHuman(
                `${flow.site}: "${a.goal}" already went through on an earlier try of this step; check it before running again`,
              );
            await stepped(
              { kind: "act", goal: a.goal, op: op.kind, hints },
              () => actOnce(op, hints, a),
              (how) => how,
            );
            if (once) runner.done?.add(call as string, once);
          },
          async signIn(site, account) {
            if (!runner.login || signingIn) return "no-login";
            signingIn = true;
            try {
              return await stepped(
                { kind: "sign-in", goal: `sign in to ${site ?? flow.site}` },
                () =>
                  (runner.login as NonNullable<RunnerOptions["login"]>)(
                    fp,
                    site ?? flow.site,
                    account,
                  ),
              );
            } finally {
              signingIn = false;
            }
          },
          captcha: () =>
            stepped(
              { kind: "captcha", goal: "solve the captcha" },
              () => solveWithRetries(),
              (got) => (got.solved ? "ok" : "failed"),
            ),
          human(reason) {
            throw new NeedsHuman(`${flow.site}: ${reason}`);
          },
          passkeys: session.passkeys,
          screens: help,
        };
        /** An interrupt the page shows now: a coded one, else a click learned on this site. */
        async function interruptHere(overlaysOnly: boolean): Promise<Screen | null> {
          for (const s of INTERRUPTS)
            if ((!overlaysOnly || s.overlay) && (await isOn(s, { fp }))) return s;
          if (overlaysOnly || !learned.has(flow.site)) return null;
          const row = learned.find(flow.site, null, await lookAt(active));
          const click = row?.click;
          if (!row || !click) return null;
          return {
            name: `learned click on ${row.url}`,
            looks: row.reason,
            is: async () => true,
            act: () =>
              doOp(active, click, { kind: "click" }, ACT_TIMEOUT_MS, hands).then(
                () => learned.used(row),
                (err: unknown) => {
                  learned.drop(row);
                  throw err;
                },
              ),
          };
        }
        /**
         * Handle an interrupt; false when its handler failed. Its clicks are
         * not the flow's acts: they neither count (an irreversible act is
         * known by its place in the flow) nor take the step's goal.
         */
        async function handle(s: Screen, goal: string, hints: Hints): Promise<boolean> {
          const bare: FlowPage = {
            ...fp,
            page: active,
            act: (op, h) => doOp(active, h, op, ACT_TIMEOUT_MS, hands),
          };
          const ok = await (s.act?.({ fp: bare }) ?? Promise.resolve()).then(
            () => true,
            () => false,
          );
          lastGoal = goal;
          lastHints = hints;
          return ok;
        }
        /**
         * Before an act: wait for its control, handling what shows up in the
         * way. An overlay (a cookie banner) is looked for once per page even
         * when the control shows. Returns the time left for the act.
         */
        async function clearWay(hints: Hints, op: Op, goal: string, timeout: number) {
          const start = Date.now();
          const url = active.url();
          if (url !== overlaysAt) {
            overlaysAt = url;
            const s = await interruptHere(true);
            if (s) await handle(s, goal, hints);
          }
          // A file input is hidden on purpose.
          if (op.kind === "upload") return timeout;
          let target: Locator;
          try {
            target = locate(active, hints);
          } catch {
            return timeout;
          }
          let handled = 0;
          while (Date.now() - start < timeout) {
            if (await target.isVisible().catch(() => false)) break;
            const s = handled < MAX_DETOURS ? await interruptHere(false) : null;
            if (s) {
              handled += 1;
              await handle(s, goal, hints);
              continue;
            }
            await active.waitForTimeout(POLL_MS);
          }
          return Math.max(timeout - (Date.now() - start), 1_000);
        }
        /** One act: the recorded locator, else the repairer's; "repaired" when the second found it. */
        async function actOnce(
          op: Op,
          hints: Hints,
          a: Parameters<FlowPage["act"]>[2],
        ): Promise<"ok" | "repaired"> {
          const timeout = a.timeoutMs ?? ACT_TIMEOUT_MS;
          const page = active;
          const mayRepair = !a.irreversible || runner.repairIrreversible;
          // A kept fix first: the source's hints are known stale, so no wait on them and no model.
          const key = flowKey(flow.site, flow.name);
          const fix = mayRepair ? (runner.fixes?.find(key, a.goal, hints) ?? null) : null;
          if (fix) {
            try {
              for (const d of fix.detours) await doOp(page, d, { kind: "click" }, timeout, hands);
              await doOp(page, fix.hints, op, timeout, hands);
              runner.fixes?.used(key, a.goal, hints);
              return "repaired";
            } catch {
              // The page moved again (or back): drop it and go the long way.
              runner.fixes?.drop(key, a.goal, hints);
            }
          }
          try {
            await doOp(page, hints, op, await clearWay(hints, op, a.goal, timeout), hands);
            return "ok";
          } catch (err) {
            if (!mayRepair)
              throw new NeedsHuman(`${flow.site}: ${a.goal} (irreversible, not repaired)`);
            // Something on top that came late: handled, then the op once more.
            const late = await interruptHere(false);
            if (late && (await handle(late, a.goal, hints)))
              try {
                await doOp(page, hints, op, timeout, hands);
                return "ok";
              } catch {
                // the long way
              }
            // On the live page, from where the run is: a few clicks past what is in
            // the way, then the op. The run goes on from there; nothing replays.
            const detours: Hints[] = [];
            const passed: { look: PageLook; reason: string }[] = [];
            for (;;) {
              const proposal = await repairer.propose({
                site: flow.site,
                goal: a.goal,
                failed: hints,
                url: page.url(),
                snapshot: await snapshotPage(page),
                ...(detours.length ? { detours } : {}),
              });
              if (!proposal) throw err;
              if (proposal.detour) {
                const name = `${proposal.hints.name ?? ""} ${proposal.hints.text ?? ""}`;
                if (detours.length >= MAX_DETOURS || COMMITTING.test(name)) throw err;
                const look = await lookAt(page);
                await doOp(page, proposal.hints, { kind: "click" }, timeout, hands);
                detours.push(proposal.hints);
                passed.push({ look, reason: proposal.reason });
                continue;
              }
              const report: RepairReport = {
                ...proposal,
                ...(detours.length ? { detours } : {}),
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
                // Each screen clicked past is an interrupt for every flow on the site from now on.
                passed.forEach(({ look, reason }, i) => {
                  learned.keep({
                    site: flow.site,
                    url: look.url,
                    landmarks: keepOf(look),
                    click: detours[i] as Hints,
                    reason,
                  });
                });
              } finally {
                runner.onRepair?.(report);
                runner.fixes?.learn(report);
                if (canLearn(repairer)) await repairer.learn(report);
              }
              return "repaired";
            }
          }
        }
        async function solveWithRetries(): Promise<CaptchaOutcome> {
          const eyes = runner.captcha?.eyes ?? null;
          const attempts = runner.captcha?.attempts ?? 3;
          let got: CaptchaOutcome = {
            solved: false,
            kind: null,
            vendor: null,
            reason: "captcha attempts are 0 (CAPTCHA_ATTEMPTS)",
          };
          for (let n = 1; n <= attempts; n++) {
            got = await solveCaptcha(active, { hands, eyes });
            // Nothing there, or a picture with no eyes: another try would say the same.
            if (got.solved || !got.kind || (!eyes && got.kind !== "checkbox")) break;
          }
          return got;
        }
        async function openPage(url: string, o: { allowWall?: boolean }): Promise<void> {
          active = session.page;
          const stay = keepPage && samePage(session.page.url(), url);
          keepPage = false;
          if (!stay) await settle(session.page, url);
          if (OFFLINE_PAGE.test(session.page.url()))
            throw new Error(`net::ERR_INTERNET_DISCONNECTED opening ${url}`);
          if (o.allowWall) return;
          // Twice: a security page asks for the password again right after a sign-in.
          for (let attempt = 1; ; attempt++) {
            const wall = await looksLikeWall(session.page);
            if (!wall) return;
            // Signed in, yet the page still asks: say what it shows, not just "a login page".
            const after =
              attempt > 1
                ? ` after a sign-in that reported success (${describePage(session.page.url(), await session.page.innerText("body").catch(() => ""))}); if that is the login page itself, store a page behind it as the credential's url`
                : "";
            if (wall.kind === "captcha" && runner.captcha && !triedCaptcha) {
              triedCaptcha = true;
              const got = await fp.captcha();
              if (got.solved) {
                // A checkbox wall lets the page through on its own (Cloudflare reloads it).
                await session.page
                  .waitForLoadState("networkidle", { timeout: SETTLE_MS })
                  .catch(() => undefined);
                continue;
              }
              throw new NeedsHuman(`${flow.site}: captcha (${got.reason})${after}`);
            }
            if (wall.kind === "captcha" || !runner.login || signingIn || attempt > 2)
              throw new NeedsHuman(`${flow.site}: ${wall.detail}${after}`);
            signingIn = true;
            try {
              const login = runner.login;
              const outcome = await stepped(
                { kind: "sign-in", goal: `sign in to ${flow.site}` },
                () => login(fp, flow.site),
              );
              if (outcome !== "signed-in")
                throw new NeedsHuman(`${flow.site}: ${wall.detail} (${outcome})`);
            } finally {
              signingIn = false;
            }
            await settle(session.page, url);
          }
        }
        try {
          return await flow.run(fp, input);
        } catch (err) {
          const artifacts: Artifacts = watch ? { steps: watch.dir } : {};
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
            ...(lastHints ? { hints: lastHints, actsBefore } : {}),
            error: redactText(err instanceof Error ? err.message : String(err)),
            kind,
            at: new Date().toISOString(),
            ...(artifacts.screenshot ? { screenshot: artifacts.screenshot } : {}),
            ...(artifacts.aria ? { aria: artifacts.aria } : {}),
            ...(watch ? { steps: watch.dir } : {}),
          };
          artifacts.failure = join(artifactsDir, `${stamp}.failure.json`);
          writeFileSync(artifacts.failure, JSON.stringify(record, null, 2));
          runner.onFailure?.(record, artifacts.failure);
          if (err instanceof NeedsHuman) {
            err.artifacts = artifacts;
            throw err;
          }
          if (kind === "interrupted") {
            broken = true;
            throw new FlowInterrupted(`${flow.site}/${flow.name}`, err, artifacts);
          }
          throw new FlowFailed(`${flow.site}/${flow.name}`, err, artifacts);
        } finally {
          runner.fixes?.flush();
          learned.flush();
          // A watched run keeps its trace whatever happened; a failure saved one already.
          if (tracing)
            await session.context.tracing
              .stop(watch ? { path: join(watch.dir, "trace.zip") } : undefined)
              .catch(() => undefined);
          if (runner.park && !broken) {
            // Stubs from `answer` belong to this run.
            await session.context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
            await runner.park.put(flow.site, session);
          } else await session.close();
        }
      }),
  };
}
