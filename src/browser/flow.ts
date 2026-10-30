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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FileChooser, Locator, Page } from "playwright";
import { resumeDir, statsDirOf } from "../deps/stats.js";
// Explore's panel; moves to browser/ once its open peer edit lands.
import type { Command } from "../explore/commands.js";
import { overlayFor, traceRow } from "../explore/overlay.js";
import { expandHome } from "../google/auth.js";
import { tallied } from "../llm/ledger.js";
import { redactAria, redactText } from "../recorder/redact.js";
import { type FlowOutcome, type FlowRunRow, type FlowRuns, fileFlowRuns } from "../runs/flows.js";
import { shareOff, shareTrace } from "../share/share.js";
import { failureShape, firstTraceOfShape } from "../shots/traces.js";
import { currentCall, currentReach, type DoneActs, markReached, markSubmitted } from "./attempt.js";
import { bare } from "./bare.js";
import { type CaptchaOutcome, type Eyes, solveCaptcha } from "./captcha/index.js";
import { filmLog, filmStep } from "./film.js";
import { type Fixes, flowKey } from "./fixes.js";
import {
  freshSeed,
  type Hands,
  HUMAN_PACE,
  handsFor,
  instantHands,
  type Pace,
  pickOption,
  seeded,
} from "./human/index.js";
import { inPage } from "./in-page.js";
import { type Hints, locate, textOf } from "./locate.js";
import { KeyedMutex } from "./lock.js";
import { htmlForFile, NetLog, networkOn } from "./network.js";
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
import { fileResumes, keptUrl, type Resumes, sameHost } from "./resume.js";
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
  type Trail,
} from "./screens.js";
import { holdsSecret } from "./secrets.js";
import {
  AccessRefused,
  type Artifacts,
  type BrowserOptions,
  bodyText,
  type FailureRecord,
  looksLikeWall,
  NeedsHuman,
  openSession,
  pageHtml,
  type Session,
} from "./session.js";
import { scrubSecretsFile } from "./trace-secrets.js";
import { type Watch, watches, watchSteps } from "./watch.js";
import type { Passkeys } from "./webauthn.js";

/** Calls a flow's log keeps, and their body bytes. */
const FLOW_NET_ROWS = 300;
const FLOW_NET_BYTES = 8 * 1024 * 1024;

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
  /** The pointer onto the control, and it stays: a hover menu, a control shown on hover, a tooltip. */
  | { kind: "hover" }
  /**
   * Files into a file input, or through the chooser a button opens: paths or refs, or bytes
   * held in memory (a stored file), which reach the page without touching the disk.
   */
  | { kind: "upload"; files: string[] | FilePayload[] }
  /** A script: a function of `el` on the target, or an expression on the page when there are no hints. */
  | { kind: "script"; js: string };

/** No hints at all: an act on the page, not an element. */
export const pageWide = (h: Hints): boolean => !Object.values(h).some((v) => v != null);

/** A file held in memory, as Playwright's `setInputFiles` takes it. */
export interface FilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

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
  /**
   * Visible now, or within `withinMs` when given (a page still rendering its
   * next step); a wait handles interrupts on the way, as an act does.
   */
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
  /**
   * A new IP for this profile, when its exit rotates (`browser/egress`): true
   * once the line has the new address. False on the machine's own line.
   */
  newIp(): Promise<boolean>;
  /** Stop here and ask a person. */
  human(reason: string): never;
  /** What a screens walk asks of the runner: the page's shape, learned screens, a model (`browser/screens`). */
  screens?: ScreenHelp;
  /** The session's page calls, redacted (`browser/network`); absent in fakes. */
  network?: NetLog;
}

export interface BrowserFlow<I, O> {
  site: Site;
  /** Unique per site; names the trace files and the fake in tests. */
  name: string;
  /** The flow puts a secret on screen (a minted token): no screenshot, trace or step watch keeps it. */
  secret?: boolean;
  /**
   * "provider": open the profile where the site's sign-in provider holds the
   * session (William's LinkedIn signs in by Google, in the `google` profile),
   * the one `autobrowse login` keeps warm. The site's own profile otherwise.
   */
  profile?: "provider";
  run(fp: FlowPage, input: I): Promise<O>;
  /**
   * The part of `run` safe to do before anyone says yes: open the page, find the box. Armed
   * (`sites/arm`), it runs early in its own tab; the call then runs `run` there, and `run`'s
   * own opening finds the page already open. Never types, clicks or sends.
   */
  prepare?(fp: FlowPage, input: I): Promise<void>;
}

export function defineFlow<I, O>(flow: BrowserFlow<I, O>): BrowserFlow<I, O> {
  return flow;
}

export interface FlowRunner {
  /** `on`: run in this tab (an armed one, `tab`) instead of the browser's own page, kept as it is. */
  run<I, O>(flow: BrowserFlow<I, O>, input: I, on?: { page: Page }): Promise<O>;
  /**
   * A new tab in `site`'s browser (a profile name: `linkedin@wren`) that outlives the runs on it:
   * the browser stays open, pinned in the park, until `release`. Flows on the profile still
   * queue and run beside it. Absent without a park.
   */
  tab?(site: string): Promise<HeldTab>;
}

export interface HeldTab {
  page: Page;
  /** The browser is the person's own: nothing context-wide or page-routed is done to it. */
  shared: boolean;
  /** Close the tab and let the browser idle out again. */
  release(): Promise<void>;
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
  /** The page-call log's caps (`browser/network`); a flow's short log by default. An explore session keeps more. */
  network?: { maxRows: number; maxBodyBytes: number };
  /**
   * How a person's hands would do each act (`browser/human`): a pause to
   * read, a curved reach, typing in runs. On by default; null is instant
   * (tests, demos).
   */
  pace?: Pace | null;
  /** Every run's motion seed, to replay a run's moves (`AUTOBROWSE_SEED`). Absent: fresh per run, kept in its row. */
  seed?: number;
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
  /**
   * Draw the terminal panel and a pulsing box on each act's control
   * (`explore/overlay`) for a person who watches or a film. Off by default:
   * the desk runs headed on real accounts, and the layer is a node a page script can see.
   * Never on a secret flow or the person's own browser.
   */
  overlay?: boolean;
  /**
   * One line per run, success or not (`runs/flows`): outcome, time, acts,
   * captcha tries, model tokens. Absent = the stats dir (`deps/stats`,
   * `~/.config/autobrowse/flows`, read by `autobrowse success`); null = none.
   */
  runs?: FlowRuns | null;
  /**
   * Where a keyed run (`withCall`) stopped, so the next try of the same call opens that page
   * and its walks go on from there (`browser/resume`). Absent = files in the owner's state dir
   * (`deps/stats`, `~/.config/autobrowse/resume`); false = every try starts at step 1.
   */
  resume?: Resumes | false;
}

const ACT_TIMEOUT_MS = 15_000;
/** How often a step waiting for its control looks for something in the way. */
const POLL_MS = 250;
/** Clicks past what is in the way before one act gives up: a new screen or two, not a new flow. */
const MAX_DETOURS = 3;

/** One flow-run row (`runs/flows`), timed from `startedAt` to now. */
function runRow(
  flow: { site: Site; name: string },
  startedAt: number,
  r: Omit<FlowRunRow, "site" | "flow" | "startedAt" | "endedAt" | "ms">,
): FlowRunRow {
  return {
    site: flow.site,
    flow: flow.name,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    ms: Date.now() - startedAt,
    ...r,
  };
}

/** `AUTOBROWSE_SEED`: one run's seed, to replay its motions. */
export function seedOf(given = process.env.AUTOBROWSE_SEED): number | undefined {
  const n = Number(given);
  return given && Number.isInteger(n) && n >= 0 ? n >>> 0 : undefined;
}

/** The same page, fragment aside. */
function samePage(current: string, url: string): boolean {
  const strip = (u: string) => u.replace(/#.*$/, "").replace(/\/$/, "");
  return strip(current) === strip(url);
}

// Busy apps never go idle: this caps what each open pays (8 s was half of an App Store Connect step).
const SETTLE_MS = 4_000;
/** AWS's console → sign-in chain takes 30–60 s to DOMContentLoaded headless; Playwright's 30 s default cut it. */
const NAVIGATE_MS = 90_000;

/**
 * Navigate and let client-side redirects finish: a dashboard that bounces
 * to its login page does so after DOMContentLoaded, and a wall check
 * before that would call an unauthenticated page "signed in".
 */
async function settle(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATE_MS });
  // after the load: a goto that fails offline reached nothing
  markReached();
  await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => undefined);
}

/**
 * Choose a value on a `<select>`, or on a custom dropdown (a combobox/button
 * that opens a list): open it, then click the option whose text is the value.
 * The step stays a `select` either way, so a recording replays the same.
 */
export async function chooseOption(
  target: Locator,
  value: string,
  timeout: number,
  hands: Hands = instantHands,
): Promise<void> {
  const o = { timeout };
  // Asked to choose: a combobox input opens a list too.
  await pickOption(target, value, o, (l) => hands.click(l, o), null);
}

async function doOp(
  page: Page,
  hints: Hints,
  op: Op,
  timeout: number,
  hands: Hands,
): Promise<void> {
  if (op.kind === "script" && pageWide(hints)) {
    await inPage(page, op.js);
    return;
  }
  const target = locate(page, hints);
  await hands.think(page);
  switch (op.kind) {
    case "script":
      // A string is an expression to Playwright, never called: wrap it as a function of el.
      await target
        .first()
        .evaluate(
          new Function("el", `return (${op.js})(el);`) as (el: unknown) => unknown,
          undefined,
          {
            timeout,
          },
        );
      return;
    case "click":
      return hands.click(target, { timeout });
    case "fill":
      return hands.type(target, op.value, { timeout });
    case "select":
      return chooseOption(target, op.value, timeout, hands);
    case "press":
      return hands.press(target, op.key, { timeout });
    case "hover":
      return hands.hover(target, { timeout });
    case "upload": {
      if (op.files.some((f) => typeof f !== "string"))
        return uploadFiles(page, target, op.files as FilePayload[], timeout, hands);
      // A ref from another machine (s3://, a signed URL) becomes a temp file for this act.
      const { localCopies } = await import("./run-files.js");
      const local = await localCopies(op.files as string[]);
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
  files: string[] | FilePayload[],
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
  // A filmed page hears every act (`browser/film`); the rest drop it. Hands per run, on that
  // run's seed: runs on two profiles at once never share a stream.
  const pace = runner.pace === undefined ? HUMAN_PACE : runner.pace;
  const fixedSeed = runner.seed ?? seedOf();
  const handsOn = (seed: number) => handsFor(pace, seeded(seed), filmLog, holdsSecret);
  const park = runner.park;
  const runsDir = runner.runs === undefined ? statsDirOf("flows") : null;
  const runs = runner.runs ?? (runsDir ? fileFlowRuns(runsDir) : null);
  const resumesDir = runner.resume === undefined ? resumeDir() : null;
  const resumes =
    runner.resume === false
      ? null
      : (runner.resume ?? (resumesDir ? fileResumes(resumesDir) : null));
  const tab = park
    ? async (site: string): Promise<HeldTab> => {
        const asked = opts.profile ?? site;
        const key = (await opts.profileName?.(asked)) ?? asked;
        return locks.withLock(key, async () => {
          const session = (await park.take(key)) ?? (await openSession(site, opts));
          park.pin(key);
          try {
            const page = await session.context.newPage();
            let released = false;
            return {
              page,
              shared: session.shared === true,
              release: async () => {
                if (released) return;
                released = true;
                await page.close().catch(() => undefined);
                park.unpin(key);
              },
            };
          } catch (err) {
            park.unpin(key);
            throw err;
          } finally {
            await park.put(key, session);
          }
        });
      }
    : undefined;
  return {
    ...(tab ? { tab } : {}),
    run: async (flow, input, on) => {
      const profile =
        flow.profile === "provider" ? ((await opts.providerProfile?.(flow.site)) ?? null) : null;
      // A profile opens once: everything that lands on one Chrome profile shares one queue and
      // one parked browser. A flow under its site (`reddit`) and under its account's profile
      // (`reddit@wren`, the sites facade) resolve to the same profile, as openSession does.
      const asked = profile ?? opts.profile ?? flow.site;
      const key = (await opts.profileName?.(asked)) ?? asked;
      return locks.withLock(key, async () => {
        // Opening the browser is the first thing the network or the machine can break.
        const opening = Date.now();
        const parked = (await runner.park?.take(key)) ?? null;
        const held =
          parked ??
          (await openSession(flow.site, profile ? { ...opts, profile } : opts).catch(
            (err: unknown) => {
              const transient = isTransientBrowserError(err);
              // A run that never got a browser is still a run: the row says it broke here.
              runs?.record(
                runRow(flow, opening, {
                  outcome:
                    err instanceof NeedsHuman ? "human" : transient ? "interrupted" : "failed",
                  submitted: false,
                  goal: "open the browser",
                  error: redactText(err instanceof Error ? err.message : String(err)),
                  acts: 0,
                  captchaTries: 0,
                  captchaSolved: null,
                  llmCalls: 0,
                  inputTokens: 0,
                  outputTokens: 0,
                }),
              );
              if (transient) throw new FlowInterrupted(`${flow.site}/${flow.name}`, err, {});
              throw err;
            },
          ));
        // An armed tab stands in for the browser's page; everything else is the browser's.
        const armed = on && !on.page.isClosed() ? on.page : null;
        const session: Session = armed
          ? (Object.create(held, { page: { value: armed } }) as Session)
          : held;
        // A kept browser already on the page the flow opens first stays put:
        // reloading would lose what the last run left there (a form, a list, an armed reply box).
        let keepPage = parked !== null || armed !== null;
        // A flow keeps a short log: enough to see the call that broke, not a session's worth.
        // Off by default (`networkOn`).
        const network = networkOn()
          ? NetLog.of(session.context, {
              site: key,
              maxRows: FLOW_NET_ROWS,
              maxBodyBytes: FLOW_NET_BYTES,
              ...runner.network,
            })
          : undefined;
        let broken = false;
        const stamp = `${flow.site}-${flow.name}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        let lastGoal: string | null = null;
        const call = currentCall();
        // Where an earlier try of this call stopped, on this profile: its first open goes there.
        const saved = call && resumes ? resumes.get(call) : null;
        const resume = saved?.profile === key ? saved : null;
        let resumeTo = resume?.url ?? null;
        let resumed = false;
        let firstOpen: string | null = null;
        const screensDone: Record<string, string[]> = structuredClone(resume?.screensDone ?? {});
        const trail: Trail = {
          before: (w) => resume?.screensDone[w] ?? [],
          passed: (w, screen) => {
            screensDone[w] = [...(screensDone[w] ?? []), screen];
          },
        };
        // What the last act or read looked for: a heal finds the one op that broke by it.
        let lastHints: Hints | null = null;
        let acts = 0;
        let actsBefore = 0;
        mkdirSync(artifactsDir, { recursive: true });
        // Tracing is best effort: a CDP-attached context may refuse it. Never
        // in the person's own browser: it would film their other tabs. A filmed
        // session's frames are the film's: a page has one screencast, and its first client sets the size.
        const tracing =
          !flow.secret &&
          !session.shared &&
          (await session.context.tracing
            .start({ screenshots: !session.filmed, snapshots: true })
            .then(() => true)
            .catch(() => false));
        let signingIn = false;
        let triedCaptcha = false;
        let captchaTries = 0;
        let captchaSolved: boolean | null = null;
        const startedAt = Date.now();
        const seed = fixedSeed ?? freshSeed();
        const hands = handsOn(seed);
        let outcome: FlowOutcome = "ok";
        let failure: string | null = null;
        // Provisional until the run ends ok: a repair that clicked the wrong control fails later.
        const repaired: { report: RepairReport; passed: { look: PageLook; reason: string }[] }[] =
          [];
        const fixesUsed: { goal: string; hints: Hints }[] = [];
        let submitted = false;
        let active = session.page;
        const overlay = overlayFor(runner.overlay === true && !flow.secret && !session.shared);
        // A new document wipes the layer: the panel comes back on every load, any tab.
        const redraw = (p: Page) => void overlay.loaded(p);
        const onPage = (p: Page) => p.on("load", redraw);
        if (overlay.enabled) {
          for (const p of session.context.pages()) onPage(p);
          session.context.on("page", onPage);
          overlay.tag(`seed ${seed}`);
          await overlay.set(active, { goal: `${flow.site}/${flow.name}` });
        }
        /** One trace row per step: the act's box pulses first; never a typed value. */
        const shown = async <T>(
          s: { kind: string; goal: string; op?: string; hints?: Hints; url?: string },
          run: () => Promise<T>,
          answer?: (r: T) => unknown,
        ): Promise<T> => {
          // A film gets the rows, never the drawn layer.
          const filmed = session.filmed === true && !flow.secret;
          if (!overlay.enabled && !filmed) return run();
          const page = active;
          const from = page.url();
          const started = Date.now();
          const cmd = s.op ?? s.kind;
          // An open's goal holds the whole URL: the row shows its host and path only.
          const c = { cmd, hints: s.hints, url: s.url, ...(s.url ? {} : { goal: s.goal }) };
          await overlay.begin(page, cmd);
          if (s.hints) await overlay.flash(page, s.hints, `${cmd}: ${s.goal}`);
          let failed: unknown = null;
          let got: T | undefined;
          try {
            got = await run();
            return got;
          } catch (err) {
            failed = err;
            throw err;
          } finally {
            await overlay.after(active);
            const row = traceRow(c as unknown as Command, failed, Date.now() - started, {
              from,
              to: active.url(),
              ...(answer && got !== undefined ? { answer: answer(got) } : {}),
            });
            await overlay.end(active, row);
            if (filmed) {
              const { cmd, what, ok, ms, note } = row;
              filmStep(page, { kind: "step", t: started, cmd, what, ok, ms, note });
            }
          }
        };
        const learned = runner.learnedScreens ?? memoryScreens();
        const help: ScreenHelp = {
          look: () => lookAt(active),
          snapshot: () => snapshotPage(active),
          learned,
          reader: runner.screenReader ?? null,
          trail,
        };
        // The URL whose overlays were last looked for: once per page, not per act.
        let overlaysAt: string | null = null;
        const watch: Watch | null =
          !flow.secret && watches(runner.watch ?? opts.watchFlows, flow.site, flow.name)
            ? watchSteps(join(artifactsDir, stamp))
            : null;
        const stepped = <T>(
          s: Parameters<Watch["step"]>[0] & { url?: string },
          run: () => Promise<T>,
          outcome?: (r: T) => "ok" | "repaired" | "failed",
        ): Promise<T> => {
          // The ledger keeps the redacted goal, never the raw url.
          const { url: _, ...step } = s;
          return shown(s, () => (watch ? watch.step(step, () => active, run, outcome) : run()));
        };
        const fp: FlowPage = {
          get page() {
            return active;
          },
          open: (url, o = {}) =>
            stepped({ kind: "open", goal: `open ${url}`, url }, () => openPage(url, o)),
          url: () => active.url(),
          text: () => bodyText(active, 20_000),
          html: () => pageHtml(active, 400_000),
          has: async (hints, withinMs = 0) => {
            // A wait handles what shows up in the way, as an act's does: a
            // guard like "the dialog opened, else a person" never misses its
            // control behind a banner or a screen learned on this site.
            if (withinMs > 0)
              await overlay
                .hold(active, () =>
                  clearWay(hints, { kind: "click" }, lastGoal ?? "wait", withinMs),
                )
                .catch(() => undefined);
            return locate(active, hints)
              .first()
              .isVisible()
              .catch(() => false);
          },
          read: async (hints) => {
            lastHints = hints;
            actsBefore = acts++;
            markReached();
            return shown(
              { kind: "read", goal: "read", hints },
              async () => (await textOf(locate(active, hints))).slice(0, 2_000),
              (text) => ({ as: "text", text }),
            );
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
          // Hands between steps: the panel lets them through.
          scroll: (dy) => overlay.hold(active, () => hands.scroll(active, dy)),
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
            // The send starts here: a failure from now on may have gone through (`attempt.ts`).
            if (a.irreversible) {
              markSubmitted();
              submitted = true;
            }
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
          newIp: () =>
            stepped(
              { kind: "new-ip", goal: "get a new IP from the exit" },
              async () => (await session.newIp?.()) ?? false,
              (got) => (got ? "ok" : "failed"),
            ),
          human(reason) {
            throw new NeedsHuman(`${flow.site}: ${reason}`);
          },
          passkeys: session.passkeys,
          ...(network ? { network } : {}),
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
          // A file input is hidden on purpose; a page-wide script has no target.
          if (op.kind === "upload" || (op.kind === "script" && pageWide(hints))) return timeout;
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
              fixesUsed.push({ goal: a.goal, hints });
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
                repaired.push({ report, passed });
              } finally {
                runner.onRepair?.(report);
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
            if (got.kind) {
              captchaTries++;
              captchaSolved = got.solved;
            }
            // Nothing there, or a picture with no eyes: another try would say the same.
            if (got.solved || !got.kind || (!eyes && got.kind !== "checkbox")) break;
          }
          return got;
        }
        async function openPage(asked: string, o: { allowWall?: boolean }): Promise<void> {
          active = session.page;
          firstOpen ??= asked;
          // The first open of a resumed try goes where the last try stopped, on the same site.
          const url = resumeTo && sameHost(resumeTo, asked) ? resumeTo : asked;
          resumed ||= url !== asked;
          resumeTo = null;
          // A kept tab already on the saved page stays: its query may hold what the saved URL drops.
          const stay =
            keepPage &&
            (samePage(session.page.url(), url) ||
              (url !== asked && keptUrl(session.page.url(), null) === keptUrl(url, null)));
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
              // The detector saw none: the word is the page's content (a story about captchas), not a wall.
              if (!got.solved && got.kind === null) return;
              if (got.solved) {
                // A checkbox wall lets the page through on its own (Cloudflare reloads it).
                await session.page
                  .waitForLoadState("networkidle", { timeout: SETTLE_MS })
                  .catch(() => undefined);
                continue;
              }
              throw new NeedsHuman(`${flow.site}: captcha (${got.reason})${after}`, "captcha");
            }
            if (wall.kind === "captcha" || !runner.login || signingIn || attempt > 2)
              throw new NeedsHuman(`${flow.site}: ${wall.detail}${after}`, wall.kind);
            signingIn = true;
            try {
              const login = runner.login;
              const outcome = await stepped(
                { kind: "sign-in", goal: `sign in to ${flow.site}` },
                () => login(fp, flow.site),
              );
              if (outcome !== "signed-in")
                throw new NeedsHuman(`${flow.site}: ${wall.detail} (${outcome})`, wall.kind);
            } finally {
              signingIn = false;
            }
            await settle(session.page, url);
          }
        }
        /**
         * Keep where this try stopped for the next try of the call. A resumed try that failed in
         * its own code without moving (same page, no new screen) drops the record instead: the
         * saved page is what broke it, so the next try starts at step 1.
         */
        function keepResume(call: string, kind: FailureRecord["kind"]): void {
          const url = keptUrl(session.page.url(), firstOpen);
          const moved =
            !resumed ||
            url !== resume?.url ||
            JSON.stringify(screensDone) !== JSON.stringify(resume?.screensDone ?? {});
          if (kind === "failed" && !moved) resumes?.clear(call);
          else if (url) resumes?.put(call, { url, profile: key, screensDone, at: Date.now() });
        }
        /** The run ended ok: its repairs and the fixes it went through are proven. */
        async function keepRepairs(): Promise<void> {
          const key = flowKey(flow.site, flow.name);
          for (const f of fixesUsed) runner.fixes?.used(key, f.goal, f.hints);
          for (const { report, passed } of repaired) {
            // Each screen clicked past is an interrupt for every flow on the site from now on.
            passed.forEach(({ look, reason }, i) => {
              learned.keep({
                site: flow.site,
                url: look.url,
                landmarks: keepOf(look),
                click: report.detours?.[i] as Hints,
                reason,
              });
            });
            runner.fixes?.learn(report);
            if (canLearn(repairer)) await repairer.learn(report);
          }
        }
        /** The run failed in the page, not the network: the fixes it went through are suspect. */
        function dropFixes(): void {
          const key = flowKey(flow.site, flow.name);
          for (const f of fixesUsed) runner.fixes?.drop(key, f.goal, f.hints);
        }
        // Any answer to this browser came from the site, an in-page fetch too: the cap counts a try.
        // A request with no answer (offline) spends nothing.
        // Playwright fires events outside this run's async context: the call's reach is held here.
        const reach = currentReach();
        const onResponse = () => {
          if (reach) reach.reached = true;
        };
        if (reach) session.context.on("response", onResponse);
        const run = tallied(() => flow.run(fp, input));
        try {
          const out = await run.done;
          if (call) resumes?.clear(call);
          await keepRepairs();
          return out;
        } catch (err) {
          const artifacts: Artifacts = watch ? { steps: watch.dir } : {};
          const shot = join(artifactsDir, `${stamp}.png`);
          if (
            !flow.secret &&
            (await bare(session.page, () =>
              session.page.screenshot({ path: shot, fullPage: true }),
            ).then(
              () => true,
              () => false,
            ))
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
          if (network && !flow.secret) {
            const calls = join(artifactsDir, `${stamp}.network.jsonl`);
            const text = network.jsonl();
            if (text) {
              writeFileSync(calls, text);
              artifacts.network = calls;
            }
            const html = await session.page.content().catch(() => null);
            if (html !== null && !network.personal) {
              const file = join(artifactsDir, `${stamp}.html`);
              writeFileSync(file, htmlForFile(html));
              artifacts.html = file;
            }
          }
          const shape = failureShape(
            flow.site,
            flow.name,
            err instanceof Error ? err.message : String(err),
          );
          if (tracing && !(await firstTraceOfShape(artifactsDir, shape))) {
            // The same failure kept a trace today: end the trace without a file.
            await session.context.tracing.stop().catch(() => undefined);
          } else if (tracing) {
            const trace = join(artifactsDir, `${stamp}.zip`);
            if (
              await session.context.tracing.stop({ path: trace }).then(
                () => true,
                () => false,
              )
            ) {
              artifacts.trace = trace;
              await scrubSecretsFile(trace).catch((e) =>
                console.warn(`trace secrets not scrubbed: ${e instanceof Error ? e.message : e}`),
              );
            }
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
            ...(artifacts.network ? { network: artifacts.network } : {}),
            ...(artifacts.html ? { html: artifacts.html } : {}),
            ...(watch ? { steps: watch.dir } : {}),
          };
          outcome = kind;
          failure = record.error;
          // a network cut proves nothing either way
          if (kind !== "interrupted") dropFixes();
          if (artifacts.trace)
            await shareTrace(artifacts.trace, { site: key, flow: flow.name, outcome: kind });
          if (call && resumes) keepResume(call, kind);
          artifacts.failure = join(artifactsDir, `${stamp}.failure.json`);
          writeFileSync(artifacts.failure, JSON.stringify(record, null, 2));
          runner.onFailure?.(record, artifacts.failure);
          if (err instanceof NeedsHuman) {
            err.artifacts = artifacts;
            throw err;
          }
          if (err instanceof AccessRefused) throw err;
          if (kind === "interrupted") {
            broken = true;
            throw new FlowInterrupted(`${flow.site}/${flow.name}`, err, artifacts);
          }
          throw new FlowFailed(`${flow.site}/${flow.name}`, err, artifacts);
        } finally {
          runs?.record(
            runRow(flow, startedAt, {
              outcome,
              submitted,
              goal: lastGoal,
              error: failure,
              acts,
              captchaTries,
              captchaSolved,
              llmCalls: run.tally.calls,
              inputTokens: run.tally.inputTokens,
              outputTokens: run.tally.outputTokens,
              seed,
            }),
          );
          if (reach) session.context.off("response", onResponse);
          runner.fixes?.flush();
          learned.flush();
          if (overlay.enabled) {
            session.context.off("page", onPage);
            for (const p of session.context.pages()) p.off("load", redraw);
            // A parked browser serves the next run: nothing of this one stays drawn.
            if (runner.park) await overlay.remove(active);
          }
          // A watched run keeps its trace whatever happened; a failure saved one already.
          // A run that worked goes to the shared library too (`share/share`), scrubbed first.
          if (tracing) {
            const share = outcome === "ok" && !shareOff();
            const path = watch
              ? join(watch.dir, "trace.zip")
              : share
                ? join(artifactsDir, `${stamp}.share.zip`)
                : null;
            const saved = await session.context.tracing
              .stop(path ? { path } : undefined)
              .then(() => true)
              .catch(() => false);
            if (saved && path && share)
              await shareTrace(path, { site: key, flow: flow.name, outcome: "ok" });
            if (path && !watch) rmSync(path, { force: true });
          }
          if (runner.park && !broken) {
            // Stubs from `answer` belong to this run.
            await session.context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
            await runner.park.put(key, held);
          } else await held.close();
        }
      });
    },
  };
}
