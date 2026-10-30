/**
 * Explore mode: one browser stays open on a site and takes commands one
 * at a time over loopback, so a flow can be mapped in seconds per step
 * instead of a full run per miss. Every act that succeeds is journaled
 * as a recorder `Action`, so `save` writes a recording the compiler
 * already understands. The person at the keyboard may be a model.
 *
 * The socket drives a signed-in browser, so it is loopback only and every
 * request carries the bearer token the CLI leaves in an owner-only file
 * (`tokenFileFor(port)`) for the session's life. What comes back is
 * masked like a transcript (tokens, keys) unless a command asks for raw.
 */

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { SecretAudit } from "credvault";
import type { Page } from "playwright";
import type { z } from "zod";
import { writeRecords } from "../agent/records.js";
import { SecretLeak, urlWithoutQuery } from "../auth/guard.js";
import type { SecretValues } from "../auth/signup.js";
import { SITE_LOGINS } from "../auth/sites.js";
import { CodeFailed, type CodeStore, planScope, runCode } from "../browser/code.js";
import { fetchFile } from "../browser/download.js";
import { extrasOf } from "../browser/extras.js";
import { filmLog } from "../browser/film.js";
import {
  type BrowserFlow,
  chooseOption,
  defineFlow,
  type FilePayload,
  type FlowPage,
  type FlowRunner,
  flowRunner,
  type Op,
  pageWide,
  type RunnerOptions,
  seedOf,
} from "../browser/flow.js";
import { ariaWithFrames, withFrame } from "../browser/frames.js";
import { freshSeed, handsFor, seeded } from "../browser/human/index.js";
import { inPage } from "../browser/in-page.js";
import { layoutText } from "../browser/layout.js";
import { type Hints, locate, locateAll, textOf } from "../browser/locate.js";
import {
  diffHtml,
  diffShapes,
  htmlForFile,
  isPersonalProfile,
  MAX_BODY_BYTES,
  MAX_ROWS,
  NETWORK_OFF,
  type NetRow,
  parseRows,
  redactUrl,
  rowLine,
  shapes,
} from "../browser/network.js";
import { checkRows, type RecordsOp, type Row, readRecords } from "../browser/records.js";
import { snapshotPage } from "../browser/repair.js";
import { lookAt, type PageLook, urlShape } from "../browser/screens.js";
import { holdsSecret, secret } from "../browser/secrets.js";
import { type BrowserOptions, bodyText, looksLikeWall, NeedsHuman } from "../browser/session.js";
import type { KeyKeeper } from "../deps/keys.js";
import type { SecretSink } from "../deps/sink.js";
import { macDesktop } from "../desktop/mac.js";
import { type Desktop, type DesktopOp, noDesktop, treeText } from "../desktop/types.js";
import type { Effects } from "../engine/effects.js";
import { memoryEffects } from "../engine/memory.js";
import { advance, applyAnswer, type OpenGate, outcomeOf, type RunStatus } from "../engine/run.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import {
  describeFile,
  type FileLine,
  type FileRecord,
  type FileStore,
  fileLine,
  filePayload,
  fileRef,
  filesInSets,
} from "../files/store.js";
import {
  type Approver,
  activates,
  amountNear,
  chargesNow,
  PaymentFlowYes,
  PaymentGate,
  PendingApprovals,
  paymentAmount,
  paymentFlowOf,
  paymentGate,
  scriptActs,
} from "../gates/payment.js";
import type { Amount } from "../gates/spend.js";
import type { Llm } from "../llm/types.js";
import { bankCodeSecret, codeWindowOpen } from "../money/bank-code.js";
import { type Charge, type Receipt, receiptOutcome, stillAsking } from "../money/charges.js";
import {
  ADDRESS_FIELDS,
  type Address,
  type BillingContacts,
  type BillingKind,
  billingKind,
  type Contacts,
  holdsBilling,
  type Profile,
  profileField,
  profileSecret,
} from "../money/profile.js";
import {
  type Card,
  cardEnding,
  cardField,
  cardSecret,
  describeCard,
  RECURRING,
} from "../money/wallet.js";
import { type RawAction, redactRaw } from "../recorder/browser.js";
import { BINDING, OBSERVER_SCRIPT } from "../recorder/observer.js";
import {
  looksLikeSecretField,
  looksLikeSecretValue,
  REDACTED,
  redactAria,
  redactRow,
  redactText,
} from "../recorder/redact.js";
import { saveRecording } from "../recorder/store.js";
import type { Action, LocatorHints, Recording } from "../recorder/types.js";
import { type Capture, captureFor } from "../runs/capture.js";
import { machine, type RunLog, type RunOutcome, runLog } from "../runs/log.js";
import { missCause, targetOf } from "../runs/success.js";
import { compiledDeps } from "../workflows/compiled-deps.js";
import {
  findable,
  find as findTools,
  sitesTree,
  type Tool,
  toolkitFor,
  toolsOf,
} from "../workflows/toolkit.js";
import {
  type Command,
  commandSchema,
  LOOKED_AT,
  LOOKS,
  placeHint,
  type targetSchema,
  toLocatorHints,
  UNBATCHABLE,
  WAITS_FOR_CONTROL,
  WHOLE_PAGE,
} from "./commands.js";
import { type Journaled, readJournal } from "./journal.js";
import { DEFAULT_IDLE_MINUTES } from "./lease.js";
import { marksFor, missed } from "./marks.js";
import { overlayFor, traceRow } from "./overlay.js";

export { type Command, commandSchema, placeHint } from "./commands.js";
export { journalFileFor, readJournal, tokenFileFor } from "./journal.js";

/** How long one yes to pay on a host lasts. */
/** A tool as an answer lists it: what to send `flow`. */
const brief = ({ name, aim, inputs }: Tool) => ({ name, aim, inputs });

const FLOW_MS = 30 * 60_000;
/** A `code` command stops after this long: a loop that never ends. */
const CODE_MS = 30 * 60_000;
/** How long a spending click's page gets to say paid or declined before it counts as no charge. */
const SETTLE_MS = Number(process.env.EXPLORE_CHARGE_SETTLE_MS ?? 60_000);
/** A frame's visible, editable text inputs, each tagged `data-ab-billing` so a locator finds it again; `billingKind` reads the label. */
const BILLING_FIELDS = `(() => {
  const skip = /^(hidden|password|checkbox|radio|submit|button|file|search|number)$/;
  const out = [];
  let i = 0;
  for (const el of document.querySelectorAll("input")) {
    if (skip.test(el.type) || el.disabled || el.readOnly) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const label = [el.type, el.name, el.id, el.autocomplete, el.placeholder,
      el.getAttribute("aria-label"), el.labels && el.labels[0] ? el.labels[0].innerText : ""].join(" ");
    el.setAttribute("data-ab-billing", String(i));
    out.push({ i: i++, label, value: el.value });
  }
  return out;
})()`;
/** How long they look for a control in frames that have not finished loading. */
const FRAME_MS = 5_000;
/** How long the whole-page measure may take before the row goes without it. */
const FULL_MS = 1_500;

const HAND_GRACE_MS = 750;
/** Rows the diff returns; `snapshot` has the rest. */
const CHANGED_ROWS = 40;

export interface PageChange {
  /** Interactive elements (one `snapshot` row each) that are new since before the act. */
  added: string[];
  /** How many rows went away. */
  gone: number;
  /** Added rows past the cap. */
  more?: number;
}

/**
 * Where an act left the page, short: an OAuth URL runs to 2 KB, and every
 * act and batch step repeats it. The path stays, a long query does not;
 * `{"cmd":"url"}` still answers the whole thing.
 */
export function shortUrl(u: string): string {
  if (u.length <= 160) return u;
  const q = u.indexOf("?");
  return q >= 0 && q <= 150 ? `${u.slice(0, q)}?…` : `${u.slice(0, 150)}…`;
}

/** An answer with its `url` fields short (the top one and each batch step's). */
function leanUrls(answer: unknown): unknown {
  if (!answer || typeof answer !== "object") return answer;
  const a = answer as Record<string, unknown>;
  const step = (d: unknown) =>
    d && typeof d === "object" && typeof (d as { url?: unknown }).url === "string"
      ? { ...d, url: shortUrl((d as { url: string }).url) }
      : d;
  return {
    ...(step(a) as object),
    ...(Array.isArray(a.done) ? { done: a.done.map(step) } : {}),
  };
}

/** What an act changed, as a multiset diff of snapshot rows. */
export function pageChange(before: readonly string[], after: readonly string[]): PageChange {
  const left = new Map<string, number>();
  for (const r of before) left.set(r, (left.get(r) ?? 0) + 1);
  const added: string[] = [];
  for (const r of after) {
    const n = left.get(r) ?? 0;
    if (n) left.set(r, n - 1);
    else added.push(r);
  }
  const gone = [...left.values()].reduce((a, b) => a + b, 0);
  return {
    added: added.slice(0, CHANGED_ROWS),
    gone,
    ...(added.length > CHANGED_ROWS ? { more: added.length - CHANGED_ROWS } : {}),
  };
}

export interface ExploreOptions {
  site: string;
  browser: BrowserOptions;
  recordingsDir: string;
  port: number;
  /** The runner's login hook: a wall on `open` is signed through with stored credentials. */
  login?: RunnerOptions["login"];
  /** Delays around acts; null (the default) answers a console at once, an agent passes human pace. */
  pace?: RunnerOptions["pace"];
  /** Captcha walls: checkboxes by hand, pictures when the eyes see. */
  captcha?: RunnerOptions["captcha"];
  /** The desktop `os` acts run on; this Mac by default, none on a headless host. */
  desktop?: Desktop;
  /** Draw the overlay (ref boxes, the act's target, the agent's goal and thought); default: when headed. */
  overlay?: boolean;
  /**
   * Compiled workflows the `flow` command may run on this page: by name, the plan with its saved
   * defaults under what the command gives, the key vault a key-minting flow keeps into. Absent: refused.
   */
  workflows?: {
    get(name: string): Promise<AnyWorkflow | null>;
    /** What `tools` and each new site's answer list; absent: legs only. */
    list?(): Promise<readonly AnyWorkflow[]>;
    plan(name: string, given: Record<string, unknown>): Promise<Record<string, unknown>>;
    keys?: KeyKeeper;
  };
  /** Writes `records` code when the command sends none; absent: `records` needs `code`. */
  llm?: Llm | null;
  /** Where `keep` puts a secret read off the page (.env locally, SSM in prod). */
  sink?: SecretSink;
  /** What `place` may fill by name; without it `place` is refused. */
  secrets?: SecretValues;
  /** Hosts a placed secret (by name) may land on; any other host refuses the `place`. Absent: any. */
  secretHosts?: (host: string, secret: string) => boolean;
  /**
   * The wallet, where there is one (the Mac): `place{secret:"card.<field>"}`
   * (or `card@<label>.<field>`) picks the card for this host, and a person says
   * yes once per card and host before any of it lands. Absent: refused.
   */
  cards?: (o: {
    host: string;
    label: string | null;
    subscription: boolean;
  }) => Promise<Card & { billing?: Address; tell?: Contacts; taxId?: string }>;
  /**
   * The code the card's bank texted to confirm a payment (3-D Secure), newest
   * numeric text received at or after `since`, from the paired phone (the Mac).
   * `place{secret:"card.code"}` uses it, only on a flow a person said yes to
   * and within 10 min of the card landing. Absent: refused.
   */
  cardCode?: (since: Date) => Promise<string | null>;
  /**
   * A yes given ahead (`spend --grant <site>`) that covers this site's payments
   * now: counts as the payment yes for `card.code`, as it answers the card's ask.
   */
  grantedAhead?: (site: string) => boolean;
  /**
   * The owner's profiles, where they live (the Mac): `place{secret:"profile.<field>"}`
   * (or `profile@<id>.<field>`) fills one of its fields, such as `taxId` on a
   * billing page. Id null: the only profile. Absent: refused.
   */
  profiles?: (id: string | null) => Promise<Profile | null>;
  /**
   * Stored files, where they live (the Mac): `upload{files:["file:<name>"]}` puts one on the
   * page from memory (a paper after a person says yes once per file and host), `read_file`
   * gives a doc's text. Absent: refused.
   */
  files?: Pick<FileStore, "list" | "get" | "sets">;
  /** Named sets (`--files <set>`) the session starts with; any file may still be used by name. */
  fileSets?: string[];
  /**
   * Which card each host was given: written when a card is placed, read when a
   * site charges the card it keeps, so every charge names its card's ending.
   */
  cardsOnFile?: {
    placed(row: { at: string; site: string; host: string; card: string }): Promise<unknown>;
    on(host: string): Promise<string | null>;
  };
  /** Each spending click a person said yes to, with its receipt page: texted, emailed, written down. */
  charges?: (c: Charge, r: Receipt, tell?: Contacts) => Promise<string[]>;
  /** Where every `place` is recorded (allowed or refused); never the value. */
  audit?: SecretAudit;
  /**
   * Who says yes to a billing field or a button that spends. Without one
   * such acts are refused: money is never a session's own call.
   */
  approve?: Approver;
  /** Where payment-flow yeses are kept across restarts; tests pass their own. */
  yesFile?: string;
  /**
   * Where the bearer token is written (owner-only) for the session's life, so a
   * shell beside the process reads it instead of a log: see `tokenFileFor`.
   */
  tokenFile?: string;
  /**
   * Minutes with no command (and no page load) before the session closes
   * itself, browser and all; four times that while paused. 0 = never.
   * A session nobody closed held its browser open for days.
   */
  idleMinutes?: number;
  /**
   * Every journaled act is appended here as it lands. A session that dies
   * (a crash, the browser gone, idle) loses nothing: the next one given the
   * same file starts with that journal and knows the page it ended on
   * (`resumedFrom`). Only `close` removes it.
   */
  journalFile?: string;
  /**
   * Where run history goes (`runs/<site>/<run>.jsonl`, src/runs/log.ts): every
   * command with what its answer cost the caller, every act with the page it
   * was done on, how it ended. Kept for good; walks are built from it.
   * Absent: no history.
   */
  runs?: string;
  /** Who drives, for the history: `console` (the default: a CLI or Claude Code over the socket), `agent:<model>`. */
  driver?: string;
  /** The first run's goal, when the caller knows it at the start. */
  goal?: string;
  now?: () => number;
}

export { DEFAULT_IDLE_MINUTES };

/** Beside a token file, `explore-<port>.json`: who serves the port. Its mtime is the last command. */
export interface ExploreInfo {
  port: number;
  /** The process serving it (the browser is its child). */
  pid: number;
  site: string;
  /** `console`, `person` (teach), `agent:<model>`. */
  driver: string;
  /** No idle close (`--hold`, teach): someone must stop it. */
  held: boolean;
  startedAt: string;
}

export interface Explorer {
  port: number;
  /** Every request carries this as `Authorization: Bearer …`; the socket drives a signed-in browser. */
  token: string;
  /** The same commands, in process: what an agent in this process calls; it waits on a payment gate. */
  exec(command: Command): Promise<unknown>;
  /** True between `pause` and `resume`; an agent waits on `resumed()` before its next step. */
  paused(): boolean;
  resumed(): Promise<void>;
  /** Resolves when `close` arrives or the browser goes away. */
  done: Promise<void>;
  /** What a dead session's journal carried in: its acts and the page it ended on. */
  resumedFrom: { acts: number; url: string | null } | null;
  /** The run the history is writing now; null without `runs` or between `done` and the next command. */
  runId(): string | null;
  /** The files the session started with (`fileSets`). */
  files: FileLine[];
}
export type ExploreCommand = Command;

/**
 * After an act: a page it navigated to loads, then a short wait for the network
 * to go quiet. Live apps (Facebook, X) poll forever and never reach networkidle,
 * so waiting for it cost the full cap on every act; the next command's locator
 * waits for its own control anyway.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 1_500 }).catch(() => undefined);
}

/** Resolves once the DOM has not changed for 300 ms, or after 3 s on a page that never stops. */
const DOM_QUIET = `() => new Promise((done) => {
  let t;
  const end = () => { o.disconnect(); clearTimeout(cap); done(true); };
  const o = new MutationObserver(() => { clearTimeout(t); t = setTimeout(end, 300); });
  o.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  t = setTimeout(end, 300);
  const cap = setTimeout(end, 3000);
})`;

/**
 * Explore runs as one long flow: the runner owns the session, so a login
 * wall on `open` is signed through, popups are tracked, and the profile
 * is the same one the compiled flow will use.
 */
/** Every button's words on the page (in the page, as a string: no DOM types here). */
const BUTTON_LABELS = `[...document.querySelectorAll("button,[role=button],input[type=submit],input[type=button]")]
  .map((e) => e.innerText || e.value || e.getAttribute("aria-label") || "")
  .filter(Boolean)
  .slice(0, 300)`;

export async function startExplore(opts: ExploreOptions): Promise<Explorer> {
  // An unknown set fails before a browser opens.
  if (opts.fileSets?.length && !opts.files)
    throw new Error("--files: no files here (they live on the Mac: autobrowse files add)");
  const files =
    opts.fileSets?.length && opts.files ? await filesInSets(opts.files, opts.fileSets) : [];
  const ready = new Promise<{ fp: FlowPage; finish: () => void }>((resolve, reject) => {
    const flow = defineFlow<undefined, void>({
      site: opts.site,
      name: "explore",
      run: (fp) =>
        new Promise<void>((finish) => {
          resolve({ fp, finish });
        }),
    });
    const runner = flowRunner(opts.browser, {
      pace: opts.pace ?? null,
      network: { maxRows: MAX_ROWS, maxBodyBytes: MAX_BODY_BYTES },
      ...(opts.login ? { login: opts.login } : {}),
      ...(opts.captcha ? { captcha: opts.captcha } : {}),
    });
    // A run that fails before the flow starts (the profile held elsewhere) is the opener's
    // error; once started, `ready` has settled and the rejection is a no-op.
    void runner.run(flow, undefined).catch(reject);
  });
  const { fp, finish: finishFlow } = await ready;
  return serve(opts, fp, finishFlow, files);
}

/** One `os` act against the desktop; the tree comes back as text like `aria` does. */
async function runDesktop(d: Desktop, a: DesktopOp, shotsDir: string, n: number): Promise<unknown> {
  switch (a.op) {
    case "apps":
      return { apps: await d.apps() };
    case "open":
      await d.open(a.app);
      return { ok: true };
    case "tree":
      return { tree: redactText(treeText(await d.tree(a.app, a.depth))) };
    case "click":
      await d.click({
        name: a.name,
        ...(a.role ? { role: a.role } : {}),
        ...(a.app ? { app: a.app } : {}),
      });
      return { ok: true };
    case "type":
      await d.type(a.text);
      return { ok: true };
    case "key":
      await d.key(a.combo);
      return { ok: true };
    case "shot": {
      const file = join(shotsDir, `os-${String(n).padStart(4, "0")}.png`);
      await d.screenshot(file);
      return { file };
    }
    case "shell": {
      const r = await d.shell(a.command, a.root ?? false);
      // Output can hold tokens: masked like everything else that leaves the socket.
      return {
        code: r.code,
        stdout: redactText(r.stdout.slice(0, 4_000)),
        stderr: redactText(r.stderr.slice(0, 1_000)),
      };
    }
    case "wait":
      await new Promise((r) => setTimeout(r, a.ms));
      return { ok: true };
  }
}

async function serve(
  opts: ExploreOptions,
  fp: FlowPage,
  finishFlow: () => void,
  sessionFiles: FileRecord[],
): Promise<Explorer> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const startedAt = new Date(t0).toISOString();
  const infoFile = opts.tokenFile ? `${opts.tokenFile.replace(/\.token$/, "")}.json` : null;
  const actions: Action[] = opts.journalFile ? readJournal(opts.journalFile) : [];
  const carried = actions.at(-1);
  const resumedFrom = carried ? { acts: actions.length, url: carried.url ?? null } : null;
  /** A resumed journal's times run on from where it stopped. */
  const tBase = carried ? carried.t + 1 : 0;
  const shotsDir = join(opts.recordingsDir, `.explore-${opts.site}`);
  mkdirSync(shotsDir, { recursive: true });
  const desktop = opts.desktop ?? (process.platform === "darwin" ? macDesktop() : noDesktop());
  // A resumed journal points at the earlier shots: number on past them. A fresh
  // session writes over them, so the folder stays one session's size.
  let shotN = carried ? readdirSync(shotsDir).filter((f) => /^\d{4}\.png$/.test(f)).length : 0;
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  /** The active page: it moves when a popup opens (OAuth) and comes back after; re-read per command. */
  let page: Page = fp.page;
  // A film stays clean: its rows go to the pane json.
  const overlay = overlayFor(
    opts.overlay ?? (opts.browser.headless === false && !opts.browser.film),
  );
  // A new document wipes the layer: the panel comes back on it.
  page.on("load", (p) => void overlay.loaded(p));
  let paused = false;
  let waiters: Array<() => void> = [];
  /** Acts a person did by hand since the last `pause`. */
  let handActs = 0;
  /**
   * Help without a pause: a person at a headed browser types the code the
   * agent could not get, or clicks past the screen it was stuck on, between
   * two commands. Those acts are journaled like paused ones and counted here
   * until the next command, whose answer says so (`helped`).
   */
  let helpedActs = 0;
  /** Commands in flight, and when the last one's own late DOM events stop counting as a person's. */
  let busy = 0;
  let quietAt = 0;
  /** Where the agent last left the page: the url, and the rows when its last act diffed them. */
  let left: { url: string; rows: string[] | null } | null = null;
  const byHand = () => paused || (busy === 0 && now() >= quietAt);
  const resume = () => {
    paused = false;
    for (const w of waiters) w();
    waiters = [];
  };

  // Run history: the journal is resume state and goes on `close`; the run stays.
  // A resumed session goes on writing the run its journal's sidecar names.
  const runSide = opts.journalFile ? `${opts.journalFile}.run` : null;
  let history: RunLog | null = null;
  let carriedRun =
    resumedFrom && runSide && existsSync(runSide) ? readFileSync(runSide, "utf8").trim() : null;
  let firstGoal = opts.goal ?? null;
  /** A recording was saved this run: the close that follows ends it `saved`. */
  let saved = false;
  /** How the session ended when no `done` said: an idle close, else closed. */
  let endedBy: RunOutcome | null = null;
  /** What a `close` with `why` said: the run's summary. */
  let closedWhy: string | null = null;
  /** `close` was sent: nothing of this run is left to resume. */
  let closing = false;
  /** The page the command in flight acts on, as it was before the act. */
  let lookBefore: PageLook | null = null;
  /**
   * The page as it last went quiet: the look a person's next act is done on.
   * Taken after every act, command and load; one that lands after the next
   * act came in is dropped (a fill's change event fires as the next click lands).
   */
  let handLook: PageLook | null = null;
  let lookGen = 0;
  const lookWhenQuiet = () => {
    if (!opts.runs) return;
    const gen = ++lookGen;
    const p = page;
    void (async () => {
      await p.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => undefined);
      await p.evaluate(`(${DOM_QUIET})()`).catch(() => undefined);
      const look = p.isClosed() ? null : await lookAt(p).catch(() => null);
      if (gen === lookGen && look) handLook = look;
    })();
  };
  /** The history never fails a command: a full disk loses rows, not acts. */
  const logged = (f: (h: RunLog) => void) => {
    const h = history;
    if (!h || h.ended()) return;
    try {
      f(h);
    } catch {
      // not written
    }
  };
  /**
   * What the model saw, for training (designs/2026-10-26-run-observations.md); none on a
   * personal profile. A command's pictures and marks boxes wait here for its row.
   */
  let capture: Capture | null = null;
  let stepPics: string[] = [];
  let stepBoxes: Array<[number, number, number, number]> | null = null;
  /** The screen last pictured (URL shape and landmarks): a new one takes a picture. */
  let lastScreen = "";
  /** The Claude Code session that last sent a command: rows name a change. */
  let lastSession: string | null = process.env.CLAUDE_CODE_SESSION_ID ?? null;
  const picture = async (): Promise<string | null> => {
    const c = capture;
    if (!c || page.isClosed() || secretFlow) return null;
    try {
      const shot = await overlay.around(page, () =>
        page.screenshot({ type: "jpeg", quality: 80, scale: "css" }),
      );
      return c.picture(shot);
    } catch {
      return null;
    }
  };
  const openRun = () => {
    if (!opts.runs || (history && !history.ended())) return;
    const was = carriedRun;
    carriedRun = null;
    try {
      history = runLog(opts.runs, opts.site, was ? { id: was } : {});
    } catch {
      // A sidecar naming no run (hand-edited, cut): a new one.
      history = runLog(opts.runs, opts.site);
    }
    if (runSide) writeFileSync(runSide, history.id, { mode: 0o600 });
    const runs = opts.runs;
    const id = history.id;
    try {
      capture = isPersonalProfile(opts.site) ? null : captureFor(runs, opts.site, id);
    } catch {
      capture = null;
    }
    lastScreen = "";
    const vp = page.viewportSize();
    logged((h) =>
      h.start({
        run: id,
        site: opts.site,
        driver: opts.driver ?? "console",
        goal: firstGoal,
        machine: machine(),
        resumed: was !== null,
        viewport: vp ? { width: vp.width, height: vp.height } : null,
        ...(lastSession ? { session: lastSession } : {}),
        ...(opts.pace ? { seed } : {}),
      }),
    );
    firstGoal = null;
    saved = false;
  };
  /** `resumable`: an idle close or a lost browser, whose next life goes on writing this run. */
  const endRun = async (outcome: RunOutcome, summary: string | null, resumable = false) => {
    const h = history;
    if (!h || h.ended()) return;
    // A person who closed the browser ended on the page they last saw.
    const look = page.isClosed() ? handLook : await lookAt(page).catch(() => null);
    const pic = await picture();
    logged((l) => l.end({ outcome, summary, look, ...(pic ? { pic } : {}) }));
    try {
      capture?.close();
    } catch {
      // packed by the next ship (`packStale`)
    }
    capture = null;
    if (runSide && !resumable) rmSync(runSide, { force: true });
  };
  /** The whole accessibility tree: what a full answer would have cost; null when it takes too long. */
  const wholePage = async (): Promise<string | null> => {
    const p = page;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), FULL_MS);
    });
    const tree = await Promise.race([ariaWithFrames(p).catch(() => null), late]);
    clearTimeout(timer);
    return tree;
  };
  /**
   * One command's row: how long, what its answer cost the caller in chars,
   * and (for acts and looks) what the whole page would have. The whole page
   * is measured beside the next command, never in its way.
   */
  const counted = (
    c: Command,
    t0: number,
    error: string | null,
    /** The answer as the caller got it: its length is the cost, its masked text the observation. */
    answer: string,
    /** The whole error, call log included: why a locator missed. */
    detail?: string,
    /** The Claude Code session that sent it (`x-claude-session`). */
    session?: string,
  ) => {
    // The overlay is for a person who watches; a run's rows never count it.
    if (c.cmd === "overlay") return;
    // A session control answers mid-command: the pictures wait for the command they belong to.
    const own = !IMMEDIATE.has(c.cmd);
    const pics = own ? stepPics : [];
    const boxes = own ? stepBoxes : null;
    if (own) {
      stepPics = [];
      stepBoxes = null;
    }
    const h = history;
    if (!h || h.ended()) return;
    const ms = now() - t0;
    const host = URL.canParse(page.url()) ? new URL(page.url()).host : "";
    const missed =
      error !== null && "hints" in c && c.hints && /^locator\.\w+: Timeout/.test(error)
        ? { target: redactText(targetOf(c.hints)), miss: missCause(detail ?? error) }
        : {};
    const cap = capture;
    const stored = (text: string): string | null => {
      try {
        return cap ? cap.text(text) : null;
      } catch {
        return null;
      }
    };
    const obs = stored(answer);
    const by = session && session !== lastSession ? session : null;
    if (session) lastSession = session;
    const write = (tree: string | null) => {
      const after = tree === null ? null : stored(tree);
      logged((l) =>
        l.cmd({
          cmd: c.cmd,
          ok: error === null,
          error: error === null ? null : redactText(error).slice(0, 200),
          ms,
          chars: answer.length,
          full: tree === null ? null : tree.length,
          host,
          ...missed,
          ...(obs ? { obs } : {}),
          ...(after ? { after } : {}),
          ...(pics.length ? { pics } : {}),
          ...(boxes ? { boxes } : {}),
          ...(by ? { session: by } : {}),
        }),
      );
    };
    if (error !== null || !WHOLE_PAGE.has(c.cmd)) return write(null);
    void wholePage().then(write);
  };

  // This session's page calls and saved pages, beside its shots; kept for good, shipped like them.
  const netStamp = startedAt.replace(/[:.]/g, "-");
  const netFile = join(shotsDir, `network-${netStamp}.jsonl`);
  const htmlDir = join(shotsDir, "html");
  const htmlIndex = join(htmlDir, "index.jsonl");
  let htmlN = 0;
  const writeNet = () => {
    const text = fp.network?.jsonl();
    if (text) writeFileSync(netFile, text);
  };
  /** The newest log an earlier session of this site wrote. */
  const lastNet = (): NetRow[] | null => {
    const prev = readdirSync(shotsDir)
      .filter((f) => /^network-.*\.jsonl$/.test(f) && join(shotsDir, f) !== netFile)
      .sort()
      .at(-1);
    return prev ? parseRows(readFileSync(join(shotsDir, prev), "utf8")) : null;
  };
  const network = (c: Extract<Command, { cmd: "network" }>) => {
    const log = fp.network;
    if (!log) throw new Error(NETWORK_OFF);
    writeNet();
    const rows = log.rows();
    if (c.id !== undefined) {
      const r = log.row(c.id);
      if (!r) throw new Error(`no call ${c.id} (the log keeps the newest ${MAX_ROWS})`);
      const body = r.body === undefined ? undefined : JSON.stringify(r.body, null, 1);
      const cap = c.limit ?? 20_000;
      return {
        ...r,
        ...(body !== undefined ? { body: body.slice(0, cap) } : {}),
        ...(body && body.length > cap ? { more: body.length - cap } : {}),
      };
    }
    if (c.diff) {
      const prev = lastNet();
      if (!prev) return { diff: null, reason: "no earlier session of this site" };
      return { diff: diffShapes(shapes(prev), shapes(rows)) };
    }
    const hits = c.filter ? rows.filter((r) => r.url.includes(c.filter ?? "")) : rows;
    const shown = hits.slice(-(c.last ?? 40));
    return {
      calls: shown.map(rowLine),
      ...(hits.length > shown.length ? { more: hits.length - shown.length } : {}),
      ...(log.personal ? { personal: true } : {}),
      file: netFile,
    };
  };
  const html = async (c: Extract<Command, { cmd: "html" }>) => {
    if (!fp.network) throw new Error(NETWORK_OFF);
    if (fp.network.personal) throw new Error("a personal profile keeps no HTML");
    const url = page.url();
    const text = htmlForFile(await page.content());
    mkdirSync(htmlDir, { recursive: true });
    const name = `${netStamp}-${String(htmlN++).padStart(3, "0")}.html`;
    const shape = urlShape(url);
    const before = existsSync(htmlIndex)
      ? readFileSync(htmlIndex, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { file: string; shape: string })
          .filter((e) => e.shape === shape && existsSync(join(htmlDir, e.file)))
          .at(-1)
      : undefined;
    writeFileSync(join(htmlDir, name), text);
    appendFileSync(
      htmlIndex,
      `${JSON.stringify({ file: name, url: redactUrl(url), shape, at: new Date(now()).toISOString() })}\n`,
    );
    const saved = { file: join(htmlDir, name), bytes: text.length };
    if (!c.diff) return saved;
    if (!before) return { ...saved, diff: null, reason: "no earlier save of this page" };
    const d = diffHtml(readFileSync(join(htmlDir, before.file), "utf8"), text);
    return {
      ...saved,
      diff: {
        against: before.file,
        added: d.added.slice(0, 40),
        removed: d.removed.slice(0, 40),
        addedCount: d.added.length,
        removedCount: d.removed.length,
      },
    };
  };

  const shoot = async (): Promise<string> => {
    const file = join(shotsDir, `${String(shotN++).padStart(4, "0")}.png`);
    // A failed shot is an error, never a path to a file that is not there.
    await overlay.around(page, () => page.screenshot({ path: file }));
    return file;
  };
  const journal = (a: Journaled) => {
    const act = { ...a, t: tBase + now() - t0, url: page.url() } as Action;
    actions.push(act);
    if (opts.journalFile) appendFileSync(opts.journalFile, `${JSON.stringify(act)}\n`);
    // A person's act between commands: the page as it last went quiet, before this act changed it.
    const hand = byHand();
    if (hand) lookGen++;
    const look = hand ? handLook : lookBefore;
    logged((h) => h.act(act, look, hand));
    lookBefore = null;
    if (hand) lookWhenQuiet();
  };
  // While paused, the page reports what a person does (the recorder's
  // observer), so hand-done steps sit in the same journal as the
  // commands. Un-paused, commands journal themselves and the DOM is quiet.
  await page
    .context()
    .exposeBinding(BINDING, (_src, raw: RawAction) => {
      if (!byHand()) return;
      if (paused) handActs++;
      else helpedActs++;
      journal(redactRaw(raw));
    })
    .catch(() => undefined);
  await page
    .context()
    .addInitScript(OBSERVER_SCRIPT)
    .catch(() => undefined);
  // A load between commands is a person's only when they also acted (a slow redirect is not).
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    if (paused || ((helpedActs || opts.driver === "person") && byHand()))
      journal({ kind: "navigate" });
    lookWhenQuiet();
  });

  type Target = z.infer<typeof targetSchema>;
  const find = (t: Target) => locate(page, t.hints as Hints);
  const marks = marksFor();
  /** The marks picture, names masked as `aria` masks them. */
  const takeMarks = async () => {
    const { boxes, ...taken } = await marks.take(page, shoot, async () => {
      const pic = await picture();
      if (pic) stepPics.push(pic);
    });
    if (capture)
      stepBoxes = boxes.map((b) => [
        Math.round(b.x),
        Math.round(b.y),
        Math.round(b.w),
        Math.round(b.h),
      ]);
    return {
      ...taken,
      marks: taken.marks.map((m) => ({ ...m, name: m.name && redactText(m.name) })),
    };
  };
  /**
   * Billing fields and spending buttons wait for the person; refused when
   * nobody can be asked. Over the socket the question is asked once and the
   * same command is sent again after the reply (`reason: "asked"`); in
   * process the caller waits.
   */
  const approvals = opts.approve ? new PendingApprovals(opts.approve) : null;
  /**
   * One yes per payment flow (William, 2026-09-25: "only ask one yes or no
   * for whether you want to start the payment flow and pay, not repeated
   * questions"): a yes on a site (www. and my. alike) covers every money act there (billing
   * fields, the card, checkout, pay) for FLOW_MS, across session restarts. A no is asked again.
   */
  const flowYes = new PaymentFlowYes(
    opts.yesFile ?? join(tmpdir(), "autobrowse", "payment-flows.json"),
  );
  const decide = async (
    _key: string,
    what: string,
    url: string,
    wait: boolean,
    amount: Amount | null = null,
  ) => {
    if (!approvals) throw new PaymentGate(what, "no-approver");
    // The flow is the site (my. and www. are one checkout); the yes survives a session restart.
    const flow = paymentFlowOf(url);
    if (flowYes.covers(flow)) return;
    await approvals.decide(
      `pay ${flow}`,
      {
        what: `start paying on ${flow.length > 60 ? "this page" : flow}: ${what} (one yes covers the card and the pay clicks here for ${FLOW_MS / 60_000} min)`,
        url,
        site: opts.site,
        ...(amount ? { amount } : {}),
      },
      wait,
    );
    flowYes.grant(flow, FLOW_MS);
  };
  /** Instant for a console; a person's hands when an agent drives (`pace`), on the session's seed. */
  const seed = seedOf() ?? freshSeed();
  if (opts.pace) overlay.tag(`seed ${seed}`);
  const hands = handsFor(opts.pace ?? null, seeded(seed), filmLog, holdsSecret);
  const gate = async (act: "fill" | "select" | "click", t: Target, wait: boolean) => {
    // A click is judged by what the button says too: `#checkout` or `.btn` alone names nothing.
    const said =
      act === "click"
        ? await find(t)
            .first()
            .evaluate(
              (e) =>
                (e as { innerText?: string }).innerText ||
                (e as { value?: string }).value ||
                e.getAttribute("aria-label") ||
                "",
              undefined,
              { timeout: 10_000 },
            )
            .catch(() => "")
        : "";
    const hints = {
      ...(t.hints as Hints),
      ...(said.trim() ? { text: `${t.hints.text ?? ""} ${said.trim().slice(0, 200)}` } : {}),
    };
    const what = paymentGate(act, hints);
    if (!what) return null;
    // A miss is a miss, not a question: the element must be there before anyone is asked.
    await find(t).first().waitFor({ state: "visible", timeout: 10_000 });
    // The button's own amount, else the order total next to it, else a question with no amount.
    const amount =
      act === "click"
        ? (paymentAmount(t.hints as Hints) ?? (await amountNear(find(t).first())))
        : null;
    await decide(`${act} ${JSON.stringify(t.hints)}`, what, page.url(), wait, amount);
    return { what, amount, charges: chargesNow(hints) };
  };
  /** A secret this session holds by name (a code, a minted password, a stored login). */
  const sessionSecret = async (name: string): Promise<string> => {
    if (!opts.secrets) throw new Error(`place: no secrets in this session; ${placeHint(name)}`);
    const value = await opts.secrets(name);
    if (!value)
      throw new Error(
        `place: ${name} is not available now (a code: the site's message has not arrived in the inbox this run reads yet, wait and retry); ${placeHint(name)}`,
      );
    return secret(value);
  };
  /** A field of the owner's profile. */
  const profileValue = async (
    name: string,
    want: { id: string | null; field: string },
  ): Promise<string> => {
    if (!opts.profiles)
      throw new Error("place: no profiles here (they live on the Mac: autobrowse profile set)");
    const p = await opts.profiles(want.id);
    if (!p) throw new Error(`place: ${name}: no profile ${want.id ?? "(name one: profile@<id>.)"}`);
    const value = profileField(p, want.field);
    if (!value)
      throw new Error(
        `place: ${name}: profile ${p.id} has no ${want.field} (fields: taxId, name, email, phone, ${ADDRESS_FIELDS.join(", ")})`,
      );
    return value;
  };
  /** File-and-host pairs a person said yes to this session (papers only). */
  const filesYes = new Set<string>();
  /** One file use in the audit: never its bytes or text. */
  const auditFile = (name: string, by: string, allowed: boolean) =>
    opts.audit?.record({
      at: new Date().toISOString(),
      credential: `file:${name}`,
      field: "secret",
      site: opts.site,
      url: urlWithoutQuery(page.url()),
      by,
      allowed,
    });
  /**
   * An upload's files: paths as given, or every `file:<name>` as bytes from memory, audited
   * either way. A paper first needs a person's yes for that file on this host; a doc does not.
   * Stored files and paths don't mix.
   */
  const uploadFiles = async (files: string[], wait: boolean) => {
    const old = files.find((f) => f.startsWith("paper:"));
    if (old) throw new Error(`upload: ${old} is now file:${old.slice(6)} (autobrowse files list)`);
    const names = files.map(fileRef);
    if (names.every((n) => n === null)) return files;
    if (names.some((n) => n === null))
      throw new Error("upload: stored files (file:<name>) and paths in separate uploads");
    if (!opts.files)
      throw new Error("upload: no files here (they live on the Mac: autobrowse files add)");
    const host = new URL(page.url()).host;
    const out: FilePayload[] = [];
    for (const name of names as string[]) {
      const by = `upload file:${name}`;
      const got = await opts.files.get(name);
      if (!got) {
        await auditFile(name, by, false);
        throw new Error(`upload: no file ${name} (autobrowse files list)`);
      }
      const key = `${name}@${host}`;
      if (got.file.kind === "paper" && !filesYes.has(key)) {
        const what = `upload ${describeFile(got.file)} to ${host || "this page"}`;
        try {
          if (!approvals) throw new PaymentGate(what, "no-approver");
          await approvals.decide(`file ${key}`, { what, url: page.url(), site: opts.site }, wait);
        } catch (err) {
          await auditFile(name, by, false);
          throw err;
        }
        filesYes.add(key);
      }
      await auditFile(name, by, true);
      out.push(filePayload(got.file, got.data));
    }
    return out;
  };
  /** Card-and-host pairs a person said yes to this session; the card last placed, for the receipt. */
  const cardsYes = new Set<string>();
  let placedCard: {
    line: string;
    recurring: boolean;
    tell?: Contacts;
    contacts: BillingContacts;
  } | null = null;
  /** When and where the card last landed: the bank's code is only for the payment it confirms. */
  let cardLanded: { at: number; flow: string; label: string } | null = null;
  const pageText = async () => (await page.innerText("body").catch(() => "")).slice(0, 20_000);
  /**
   * William (2026-10-04): a billing form's email, phone and tax id are always the
   * card owner's (the placed card's contacts, else the only profile's), never the
   * login email a site prefilled. Run when a card lands and before a spend click,
   * in every frame (Stripe's fields live in iframes). Names the kinds it set.
   */
  const fillBilling = async (): Promise<BillingKind[]> => {
    const p = placedCard ? null : await opts.profiles?.(null).catch(() => null);
    const want: BillingContacts =
      placedCard?.contacts ??
      (p
        ? {
            ...(p.email ? { email: p.email } : {}),
            ...(p.phone ? { phone: p.phone } : {}),
            ...(p.taxId ? { taxId: p.taxId } : {}),
          }
        : {});
    if (!Object.keys(want).length) return [];
    const set: BillingKind[] = [];
    for (const frame of page.frames()) {
      const fields = await frame
        .evaluate<{ i: number; label: string; value: string }[]>(BILLING_FIELDS)
        .catch(() => []);
      for (const f of fields) {
        const kind = billingKind(f.label);
        const value = kind ? want[kind] : undefined;
        if (!kind || !value || holdsBilling(kind, f.value, value)) continue;
        await hands.paste(frame.locator(`[data-ab-billing="${f.i}"]`), value, { timeout: 10_000 });
        set.push(kind);
      }
    }
    return set;
  };
  const placeCard = async (
    c: Extract<Command, { cmd: "place" }>,
    want: { label: string | null; field: string },
    wait: boolean,
  ) => {
    if (!opts.cards)
      throw new Error("place: no wallet here (cards live on the Mac: autobrowse wallet add)");
    const host = new URL(page.url()).host;
    const recurring = RECURRING.test(await pageText());
    const audit = (allowed: boolean) =>
      opts.audit?.record({
        at: new Date().toISOString(),
        credential: "wallet",
        field: "secret",
        site: opts.site,
        url: urlWithoutQuery(page.url()),
        by: `place ${c.secret}`,
        allowed,
      });
    let card: Card & { billing?: Address; tell?: Contacts; taxId?: string };
    try {
      card = await opts.cards({ host, label: want.label, subscription: recurring });
    } catch (err) {
      await audit(false);
      throw err;
    }
    const value = cardField(card, want.field, card.billing);
    if (!value)
      throw new Error(
        `place: ${c.secret}: ${card.label} has no ${want.field} (fields: number, exp, expMonth, expYear, expYY, cvc, name, postal; from its owner's profile: ${ADDRESS_FIELDS.join(", ")})`,
      );
    // The number and code are the card's secrets; a name or postal code is plain text.
    if (want.field === "number" || want.field === "cvc") secret(value);
    const key = `${card.label}@${host}`;
    if (!cardsYes.has(key)) {
      await decide(
        `card ${key}`,
        `put ${describeCard(card)} on ${host}${card.kind === "debit" ? " (a DEBIT card)" : ""}${recurring ? " for a recurring charge" : ""}`,
        page.url(),
        wait,
      );
      cardsYes.add(key);
    }
    await audit(true);
    await hands.think(page);
    await hands.paste(find(c), value, { timeout: 10_000 });
    journalAct(c, (target) => ({
      kind: "input",
      target,
      value: REDACTED,
      redacted: true,
      secret: c.secret,
    }));
    if (placedCard?.line !== cardEnding(card))
      await opts.cardsOnFile
        ?.placed({ at: new Date().toISOString(), site: opts.site, host, card: cardEnding(card) })
        .catch(() => undefined);
    cardLanded = { at: now(), flow: paymentFlowOf(page.url()), label: card.label };
    placedCard = {
      line: cardEnding(card),
      recurring,
      ...(card.tell ? { tell: card.tell } : {}),
      contacts: { ...card.tell, ...(card.taxId ? { taxId: card.taxId } : {}) },
    };
    const billing = await fillBilling();
    return { ok: true, secret: c.secret, ...(billing.length ? { billing } : {}) };
  };
  /**
   * The bank's confirmation code (3-D Secure, often in an iframe on the bank's
   * domain): any host and frame, but only for a card this session placed, on a
   * flow that still has a payment yes (the session's, or a `spend --grant`),
   * within the code window of the card landing, and only a text that came after.
   */
  const placeBankCode = async (
    c: Extract<Command, { cmd: "place" }>,
    want: { label: string | null },
  ) => {
    const audit = (allowed: boolean) =>
      opts.audit?.record({
        at: new Date().toISOString(),
        credential: "wallet",
        field: "secret",
        site: opts.site,
        url: urlWithoutQuery(page.url()),
        by: `place ${c.secret}`,
        allowed,
      });
    const refuse = async (why: string): Promise<never> => {
      await audit(false);
      throw new Error(`place: ${c.secret}: ${why}`);
    };
    if (!opts.cardCode)
      throw new Error(
        "place: no phone here to read the bank's code (it lives on the Mac: PHONE_NUMBER, Text Message Forwarding)",
      );
    const landed = cardLanded;
    if (!landed) return refuse("no card was placed in this session; place the card first");
    if (want.label && want.label !== landed.label)
      return refuse(`the card placed here is ${landed.label}, not ${want.label}`);
    if (!codeWindowOpen(landed.at, now()))
      return refuse("the card landed over 10 min ago; place it again for a new payment");
    const yes =
      flowYes.covers(landed.flow) ||
      [opts.site, landed.flow].some((site) => opts.grantedAhead?.(site) === true);
    if (!yes)
      return refuse(
        `no payment yes for ${landed.flow} is live; a person must say yes to the payment first (press the pay button, or spend --grant)`,
      );
    const code = await opts.cardCode(new Date(landed.at));
    if (!code)
      throw new Error(
        `place: ${c.secret} is not available now (the bank's text has not arrived on the phone yet, wait and retry)`,
      );
    await audit(true);
    await hands.think(page);
    await hands.paste(find(c), secret(code), { timeout: 10_000 });
    journalAct(c, (target) => ({
      kind: "input",
      target,
      value: REDACTED,
      redacted: true,
      secret: c.secret,
    }));
    return { ok: true, secret: c.secret };
  };
  /** After a yes and the click: the page it landed on is the receipt. A failed report never fails the click. */
  const reportSpend = async (spent: { what: string; amount: Amount | null }) => {
    if (!opts.charges) return [];
    // Told only once the page says paid or declined: a click that opened a form, or a
    // payment still processing (a captcha, a bank check), is not a charge (five false texts, 2026-09-25).
    let whole = await pageText();
    for (
      let waited = 0;
      receiptOutcome(whole) === "unclear" && waited < SETTLE_MS;
      waited += 3_000
    ) {
      if (stillAsking(whole)) return [];
      await page.waitForTimeout(3_000);
      whole = await pageText();
    }
    if (receiptOutcome(whole) === "unclear" || stillAsking(whole)) return [];
    const text = redactText(whole).slice(0, 6_000);
    const png = await overlay
      .around(page, () => page.screenshot({ fullPage: true, timeout: 15_000 }))
      .catch(() => undefined);
    const host = new URL(page.url()).host;
    const kept = placedCard
      ? null
      : await (opts.cardsOnFile?.on(host) ?? Promise.resolve(null)).catch(() => null);
    return opts
      .charges(
        {
          at: new Date().toISOString(),
          site: opts.site,
          host,
          url: urlWithoutQuery(page.url()),
          what: spent.what,
          ...(spent.amount ? { amount: spent.amount } : {}),
          card:
            placedCard?.line ??
            (kept
              ? `${kept}, the one put on ${host} before`
              : "the card the site keeps (ending not known here)"),
          recurring: placedCard?.recurring ?? RECURRING.test(whole),
          outcome: receiptOutcome(whole),
        },
        { text, ...(png ? { png } : {}) },
        placedCard?.tell,
      )
      .catch(() => []);
  };
  /** A desktop click that spends (an App Store "Buy") waits for the person the same way; "url" is the app. */
  const gateDesktop = async (a: DesktopOp, wait: boolean) => {
    if (a.op !== "click") return;
    const what = paymentGate("click", { name: a.name, ...(a.role ? { role: a.role } : {}) });
    if (!what) return;
    const app = a.app ?? (await desktop.apps())[0] ?? "desktop";
    const there = (await desktop.tree(a.app)).some(
      (n) => n.name === a.name && (!a.role || n.role === a.role),
    );
    if (!there) throw new Error(`no ${a.role ?? "control"} "${a.name}" in ${app}`);
    await decide(`os ${JSON.stringify(a)}`, `${what} in ${app}`, `app:${app}`, wait);
  };
  const journalAct = (t: Target, act: (target: LocatorHints) => Journaled) => {
    const j = act(toLocatorHints(t.hints));
    if (j.kind !== "click") {
      if (j.kind !== "input") lastClick = null;
      return journal(j);
    }
    // A stepper's second press: the first one changed the page, so it is no retry.
    const again =
      lastClick !== null &&
      JSON.stringify(lastClick.hints) === JSON.stringify(t.hints) &&
      lastChanged;
    lastClick = t;
    journal(again ? { ...j, again } : j);
  };
  /** The control last clicked: a `type` after it is journaled as its input. */
  let lastClick: Target | null = null;
  /** Whether the last looked-at command changed the page's controls. */
  let lastChanged = false;
  /** What leaves the socket: masked like a transcript, unless the caller asks for raw. */
  const out = (text: string, raw: boolean | undefined) => (raw ? text : redactText(text));

  /**
   * One browser, one hand: page commands run one after another, whoever
   * sends them (two clicks in flight would race the same page). Session
   * controls (pause, resume, journal, url, pages, close) answer at once,
   * so a person can stop a long act instead of queueing behind it.
   */
  const IMMEDIATE = new Set<Command["cmd"]>([
    "pause",
    "resume",
    "journal",
    "url",
    "pages",
    "close",
    "goal",
    // Drawing is no page work: it never waits behind an act or opens a run.
    "overlay",
  ]);
  let chain: Promise<unknown> = Promise.resolve();
  let lastTouch = now();
  /** The info file's mtime is the last touch: `browsers` reads idle time from it. */
  const touch = () => {
    lastTouch = now();
    try {
      if (infoFile) utimesSync(infoFile, new Date(), new Date());
    } catch {
      // not written yet, or removed: idle shows from the start
    }
  };
  const run = (c: Command, wait = false): Promise<unknown> => {
    touch();
    // After a `done`, the next command that works the page (or names a goal) starts the next run.
    if (c.cmd === "goal" || !IMMEDIATE.has(c.cmd)) openRun();
    if (IMMEDIATE.has(c.cmd)) return runOne(c, wait);
    const next = chain.then(() => runOne(c, wait));
    chain = next.catch(() => undefined);
    return next;
  };
  /** The page's interactive elements, masked: what a diff compares. */
  const rows = async () =>
    (await snapshotPage(page, 150))
      .split("\n")
      .filter(Boolean)
      .map((r) => redactRow(r));
  const runOne = async (c: Command, wait: boolean): Promise<unknown> => {
    page = fp.page;
    if (IMMEDIATE.has(c.cmd)) return act(c, wait);
    busy++;
    const began = now();
    let failed: unknown = null;
    let answer: unknown;
    const from = page.url();
    await overlay.begin(page, c.cmd);
    try {
      const helped = await helpedSince();
      if (history && LOOKED_AT.has(c.cmd)) lookBefore = await lookAt(page).catch(() => null);
      // A new screen before an act: the picture of the state the act was chosen on.
      const screen = lookBefore
        ? `${urlShape(lookBefore.url)}\t${lookBefore.landmarks.join("|")}`
        : "";
      if (capture && screen && screen !== lastScreen) {
        lastScreen = screen;
        const pic = await picture();
        if (pic) stepPics.push(pic);
      }
      const out = await looked(c, wait);
      left = { url: page.url(), rows: out.rows ?? left?.rows ?? null };
      answer = out.answer;
      const plain = out.answer && typeof out.answer === "object" && !Array.isArray(out.answer);
      // only an object answer can carry it: the next one gets it otherwise
      const tools = plain ? await newSiteTools().catch(() => null) : null;
      return plain && (helped || tools)
        ? { ...(helped ? { helped } : {}), ...(out.answer as object), ...(tools ? { tools } : {}) }
        : out.answer;
    } catch (err) {
      failed = err;
      throw err;
    } finally {
      await overlay.end(
        fp.page,
        traceRow(c, failed, now() - began, { from, to: fp.page.url(), answer }),
      );
      busy--;
      // Idle counts from a command's end: a long one is someone driving.
      touch();
      quietAt = now() + HAND_GRACE_MS;
      lookBefore = null;
      lookWhenQuiet();
    }
  };
  // The toolkit: the page's site's workflows, sent once per site (a host with no site clears it).
  const toolsNow = async () =>
    toolsOf(opts.workflows ? ((await opts.workflows.list?.()) ?? []) : []);
  let toolsSent = "";
  let toolsHost = "";
  const newSiteTools = async () => {
    if (!opts.workflows) return null;
    const host = URL.canParse(page.url()) ? new URL(page.url()).host : "";
    if (host === toolsHost) return null;
    const all = await toolsNow().catch(() => null);
    // a catalog that failed to load: the next answer tries again
    if (!all) return null;
    toolsHost = host;
    const kit = toolkitFor(host, SITE_LOGINS, all);
    const key = kit?.sites.join(",") ?? "";
    if (key === toolsSent) return null;
    toolsSent = key;
    return kit;
  };
  const looked = async (c: Command, wait: boolean) => {
    if (!LOOKS.has(c.cmd)) return { answer: await act(c, wait), rows: null };
    const before = await rows();
    const out = await act(c, wait).finally(() => overlay.after(fp.page));
    page = fp.page;
    const after = await rows();
    const changed = pageChange(before, after);
    lastChanged = changed.added.length + changed.gone + (changed.more ?? 0) > 0;
    return { answer: { ...(out as object), changed }, rows: after };
  };
  /**
   * What a person did since the agent's last command, once: the count, where
   * the page was and is, and what changed on it. The agent reads this as
   * "someone got me past it": it re-reads the page instead of redoing the step.
   */
  const helpedSince = async () => {
    if (!helpedActs || paused) return null;
    const acts = helpedActs;
    helpedActs = 0;
    journal({ kind: "note", text: `a person did ${acts} act(s) by hand here, unpaused` });
    const now_ = await rows();
    const out = {
      acts,
      ...(left ? { from: shortUrl(left.url) } : {}),
      url: shortUrl(page.url()),
      ...(left?.rows ? { changed: pageChange(left.rows, now_) } : {}),
      note: "A person acted in the browser since your last command. The page is where they left it: read it, do not redo their step.",
    };
    left = { url: page.url(), rows: now_ };
    return out;
  };
  /** A script that clicks, on a page that shows a spending button, needs the click's yes first. */
  const scriptGate = async (js: string, wait: boolean) => {
    if (!scriptActs(js)) return;
    const labels = await page.evaluate<string[]>(BUTTON_LABELS).catch(() => [] as string[]);
    const spend = labels
      .map((text) => paymentGate("click", { text: text.trim().slice(0, 200) }))
      .find((w) => w !== null);
    if (spend)
      await decide(
        `eval ${js.slice(0, 80)}`,
        `run a script on a page where it can ${spend.replace(/^press /, "press ")}`,
        page.url(),
        wait,
      );
  };

  /**
   * `flow`: a compiled workflow on this page (designs/2026-10-29-explore-flow.md). Its browser
   * legs run on the session's own FlowPage; each money act passes this session's gate first.
   */
  const flowRuns = new Map<string, { fx: Effects; gate: OpenGate | null }>();
  /** A secret flow runs: no pictures, rows or flat journal. */
  let secretFlow = false;
  /** The payment refusal a flow's act met: the command answers with it, not with a failed step. */
  let flowGated: PaymentGate | null = null;
  const unpaused = () =>
    paused ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve();
  /** A flow's acts journaled flat, as the same commands would be: a mixed session saves as one recording. */
  const journalOp = (op: Op, hints: Hints) => {
    const t = { hints } as Target;
    if (op.kind === "click") journalAct(t, (target) => ({ kind: "click", target }));
    else if (op.kind === "fill") {
      const secret =
        looksLikeSecretField(toLocatorHints(t.hints)) ||
        looksLikeSecretValue(op.value) ||
        holdsSecret(op.value);
      journalAct(t, (target) => ({
        kind: "input",
        target,
        value: secret ? REDACTED : op.value,
        redacted: secret,
      }));
    } else if (op.kind === "select")
      journalAct(t, (target) => ({ kind: "select", target, value: op.value }));
    else if (op.kind === "press")
      journalAct(t, (target) => ({ kind: "press", target, key: op.key }));
    else if (op.kind === "hover") journalAct(t, (target) => ({ kind: "hover", target }));
    else if (op.kind === "script" && scriptActs(op.js))
      journal({
        kind: "eval",
        target: pageWide(hints) ? null : toLocatorHints(t.hints),
        js: op.js,
      });
    // upload: the flow's own paths or bytes; a recording names stored files, so none
  };
  const flowPage = (
    flow: BrowserFlow<unknown, unknown>,
    wait: boolean,
    o: { journal?: boolean } = {},
  ): FlowPage => {
    const quiet = flow.secret === true;
    // `code` journals itself as one row: its inner ops are not replayed on their own.
    const journals = !quiet && o.journal !== false;
    /** One row per step, as a flow draws its own; a pause holds the next step. */
    const step = async <T>(
      s: { cmd: string; goal: string; hints?: Hints; url?: string },
      run: () => Promise<T>,
      answer?: (r: T) => unknown,
    ): Promise<T> => {
      await unpaused();
      page = fp.page;
      if (quiet) return run();
      const from = page.url();
      const began = now();
      await overlay.begin(page, s.cmd);
      if (s.hints) await overlay.flash(page, s.hints, `${s.cmd}: ${s.goal}`);
      let failed: unknown = null;
      let got: T | undefined;
      try {
        got = await run();
        return got;
      } catch (err) {
        failed = err;
        throw err;
      } finally {
        page = fp.page;
        await overlay.after(page);
        // An open's goal holds the whole URL: the row shows its host and path only.
        const c = { cmd: s.cmd, hints: s.hints, url: s.url, ...(s.url ? {} : { goal: s.goal }) };
        await overlay.end(
          page,
          traceRow(c as unknown as Command, failed, now() - began, {
            from,
            to: page.url(),
            ...(answer && got !== undefined ? { answer: answer(got) } : {}),
          }),
        );
      }
    };
    const money = (op: Op) =>
      op.kind === "click" || (op.kind === "press" && activates(op.key))
        ? "click"
        : op.kind === "fill" || op.kind === "select"
          ? op.kind
          : null;
    return {
      ...fp,
      // Live, not copied: after `switchTo` (a popup) it is the page acted on now.
      get page() {
        return fp.page;
      },
      open: (url, o) =>
        step({ cmd: "open", goal: `open ${url}`, url }, async () => {
          await fp.open(url, o);
          if (journals) journal({ kind: "navigate" });
        }),
      read: (hints) =>
        step(
          { cmd: "read", goal: "read", hints },
          () => fp.read(hints),
          (text) => ({ as: "text", text }),
        ),
      act: (op, hints, o) =>
        step({ cmd: op.kind, goal: o.goal, hints }, async () => {
          const kind = money(op);
          let spent: Awaited<ReturnType<typeof gate>> = null;
          try {
            if (kind) spent = await gate(kind, { hints } as Target, wait);
            if (op.kind === "script") await scriptGate(op.js, wait);
          } catch (err) {
            if (err instanceof PaymentGate) flowGated = err;
            throw err;
          }
          await fp.act(op, hints, o);
          page = fp.page;
          if (journals) journalOp(op, hints);
          if (spent?.charges) await reportSpend(spent);
        }),
    };
  };
  /** Explore as the workflow's browser: its legs run here, on this site's profile only. */
  const onPage = (wait: boolean): FlowRunner => ({
    run: async <I, O>(flow: BrowserFlow<I, O>, input: I): Promise<O> => {
      const here = opts.site.split("@")[0];
      if (flow.site !== here)
        throw new Error(
          `flow: ${flow.site}/${flow.name} needs ${flow.site}'s profile; this session is ${here}: open explore on ${flow.site}`,
        );
      secretFlow = flow.secret === true;
      const mark = fp.network?.last() ?? 0;
      try {
        return await flow.run(flowPage(flow as BrowserFlow<unknown, unknown>, wait), input);
      } finally {
        if (secretFlow) {
          await settle(fp.page).catch(() => undefined);
          fp.network?.forget(mark);
        }
        secretFlow = false;
      }
    },
  });
  const runWorkflow = async (c: Extract<Command, { cmd: "flow" }>, wait: boolean) => {
    const from = opts.workflows;
    if (!from) throw new Error("flow: no workflows in this session (the CLI's explore has them)");
    const workflow = await from.get(c.name);
    if (!workflow)
      throw new Error(`flow: no compiled workflow ${c.name}; see: autobrowse workflows`);
    const plan = workflow.plan.parse({ dryRun: false, ...(await from.plan(c.name, c.plan ?? {})) });
    if (c.fresh) flowRuns.delete(c.name);
    const run = flowRuns.get(c.name) ?? { fx: memoryEffects().fx, gate: null };
    flowRuns.set(c.name, run);
    const deps = compiledDeps(onPage(wait), {
      ...(opts.audit ? { audit: opts.audit } : {}),
      ...(opts.sink ? { sink: opts.sink } : {}),
      ...(from.keys ? { keys: from.keys } : {}),
    });
    const at = () => new Date().toISOString();
    // The gate it stopped on: the same command sent again answers it.
    if (run.gate?.name === "human")
      await applyAnswer(run.fx, run.gate, {
        approved: true,
        note: "explore: sent again",
        at: at(),
      });
    else if (run.gate?.name === "choose" && c.choice)
      await applyAnswer(run.fx, run.gate, { approved: true, note: c.choice, at: at() });
    run.gate = null;
    journal({ kind: "note", text: `flow ${c.name} start` });
    const answer = async (status: RunStatus) => {
      const o = await outcomeOf(run.fx, workflow, status);
      // Done or refused: nothing to go on from. Failed or waiting: the next call goes on.
      if (status === "done" || status === "rejected") flowRuns.delete(c.name);
      journal({ kind: "note", text: `flow ${c.name} ${status}` });
      page = fp.page;
      const g = run.gate;
      return JSON.parse(
        redactText(
          JSON.stringify({
            flow: c.name,
            status,
            steps: o.results,
            ...(g ? { gate: { name: g.name, step: g.step, prompt: g.prompt } } : {}),
            url: page.url(),
          }),
        ),
      ) as unknown;
    };
    try {
      for (;;) {
        flowGated = null;
        const a = await advance(run.fx, workflow, deps, plan);
        // Kept: the step that met the gate runs again on the next call.
        if (flowGated) throw flowGated;
        if (a.kind === "continue") continue;
        if (a.kind === "finished") return answer(a.status);
        const g = a.gate;
        if (g.name === "human" || g.name === "choose") {
          run.gate = g;
          return answer("waiting");
        }
        try {
          if (!approvals) throw new PaymentGate(g.prompt, "no-approver");
          await approvals.decide(
            `flow ${c.name} ${g.step} ${g.name}`,
            { what: `${c.name}: ${g.prompt}`, url: page.url(), site: opts.site },
            wait,
          );
        } catch (err) {
          if (!(err instanceof PaymentGate) || err.reason !== "denied") throw err;
          await applyAnswer(run.fx, g, {
            approved: false,
            note: "explore: a person said no",
            at: at(),
          });
          return answer("rejected");
        }
        await applyAnswer(run.fx, g, {
          approved: true,
          note: "explore: a person said yes",
          at: at(),
        });
      }
    } catch (err) {
      // An ask or a refusal: the run is kept, the journal says where it stopped.
      journal({ kind: "note", text: `flow ${c.name} stopped` });
      throw err;
    }
  };

  /**
   * Saved call results of `code`, by its `as` and plan, beside the journal: a resend after a fix
   * goes on from the call that failed, across a kept close. Gone with the journal.
   */
  const codeFile = opts.journalFile ? `${opts.journalFile}.code` : null;
  let codeSaved: Map<string, Map<string, { value: unknown }>> | null = null;
  const codeScopes = () => {
    if (codeSaved) return codeSaved;
    codeSaved = new Map();
    if (codeFile && existsSync(codeFile))
      for (const line of readFileSync(codeFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as { scope: string; key?: string; value?: unknown };
          if (r.key === undefined) codeSaved.delete(r.scope);
          else
            codeSaved.set(
              r.scope,
              (codeSaved.get(r.scope) ?? new Map()).set(r.key, { value: r.value }),
            );
        } catch {
          // cut by a crash
        }
      }
    return codeSaved;
  };
  const codeWrite = (row: object) => {
    if (codeFile) appendFileSync(codeFile, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  };
  const codeStore = (scope: string, fresh: boolean): CodeStore => {
    const all = codeScopes();
    if (fresh && all.delete(scope)) codeWrite({ scope });
    const mine = all.get(scope) ?? new Map<string, { value: unknown }>();
    all.set(scope, mine);
    return {
      get: (key) => mine.get(key),
      set: (key, value) => {
        mine.set(key, { value });
        codeWrite({ scope, key, value });
      },
    };
  };
  const runCodeHere = async (c: Extract<Command, { cmd: "code" }>, wait: boolean) => {
    const plan = c.plan ?? {};
    for (const text of [c.code, ...Object.values(plan)])
      if (holdsSecret(text) || redactText(text) !== text)
        throw new Error("code: it holds a secret; `place` it on the page, never in code or plan");
    const store = codeStore(planScope({ as: c.as, plan }), c.fresh === true);
    const here = flowPage(
      { site: opts.site, name: "code" } as BrowserFlow<unknown, unknown>,
      wait,
      {
        journal: false,
      },
    );
    const shown = (o: object) => JSON.parse(redactText(JSON.stringify(o))) as unknown;
    try {
      const r = await runCode(
        here,
        { code: c.code, plan },
        {
          store,
          trace: (row) => logged((h) => h.call(row)),
          deadline: now() + CODE_MS,
          passThrough: (err) => err instanceof PaymentGate,
          ...(c.started ? { started: c.started } : {}),
        },
      );
      page = fp.page;
      journal({ kind: "code", code: c.code, as: c.as, plan });
      return shown({
        as: c.as,
        rows: r.rows.length,
        calls: r.calls,
        stored: r.stored,
        first: r.rows.slice(0, 5),
        ...(r.log === undefined ? {} : { log: r.log }),
        url: page.url(),
      });
    } catch (err) {
      if (!(err instanceof CodeFailed)) throw err;
      page = fp.page;
      const r = err.result;
      return shown({
        as: c.as,
        rows: r.rows.length,
        calls: r.calls,
        stored: r.stored,
        failed: r.failed,
        url: page.url(),
      });
    }
  };

  const act = async (given: Command, wait: boolean): Promise<unknown> => {
    page = fp.page;
    // A mark from the last picture acts, and journals, as the control's own hints.
    const cmd =
      "hints" in given && given.hints?.mark
        ? ({ ...given, hints: await marks.hints(page, given.hints.mark) } as Command)
        : given;
    // A target on no frame that the page lacks is looked for in its iframes (card fields, a
    // bank's challenge). A fill or place gives frames still loading a moment.
    const c =
      "hints" in cmd && cmd.hints && !cmd.hints.frame
        ? ({
            ...cmd,
            hints: await withFrame(
              page,
              cmd.hints as Hints,
              WAITS_FOR_CONTROL.has(cmd.cmd) ? FRAME_MS : 0,
            ),
          } as Command)
        : cmd;
    if (overlay.enabled && LOOKED_AT.has(c.cmd) && "hints" in c && c.hints)
      await overlay.flash(
        page,
        c.hints as Hints,
        `${c.cmd}${"goal" in c && c.goal ? `: ${c.goal}` : ""}`,
      );
    switch (c.cmd) {
      case "overlay": {
        const { cmd: _, refs, on, ...fields } = c;
        if (on !== undefined) await overlay.toggle(page, on);
        if (on === false) return { drawn: false };
        return overlay.set(page, {
          ...fields,
          ...(refs ? { refs: refs.map((r) => ({ n: r.n, hints: r.hints as Hints })) } : {}),
        });
      }
      case "open": {
        // Through the runner: a login wall is signed through. A captcha comes back as the
        // wall, not an error: a checkbox one is clicked like any control, a puzzle goes to a person.
        try {
          await fp.open(c.url, { allowWall: !opts.login });
        } catch (err) {
          if (!(err instanceof NeedsHuman) || (await looksLikeWall(page))?.kind !== "captcha")
            throw err;
        }
        journal({ kind: "navigate" });
        return { url: page.url(), wall: await looksLikeWall(page) };
      }
      case "click": {
        const spent = await gate("click", c, wait);
        const billing = spent ? await fillBilling() : [];
        await hands.think(page);
        await hands.click(find(c), { timeout: 10_000, ...(c.at ? { at: c.at } : {}) });
        await settle(page);
        journalAct(c, (target) => ({ kind: "click", target }));
        // A receipt only for the click that takes money; checkout or "add a card" only led there.
        const set = billing.length ? { billing } : {};
        if (spent?.charges) return { url: page.url(), ...set, told: await reportSpend(spent) };
        return { url: page.url(), ...set };
      }
      case "hover": {
        await hands.think(page);
        await hands.hover(find(c), { timeout: 10_000 });
        await settle(page);
        journalAct(c, (target) => ({ kind: "hover", target }));
        return { url: page.url() };
      }
      case "drag": {
        await hands.think(page);
        await hands.drag(find(c), c.from, c.to, { timeout: 10_000 });
        await settle(page);
        return { url: page.url() };
      }
      case "fill": {
        await gate("fill", c, wait);
        await hands.think(page);
        await hands.type(find(c), c.value, { timeout: 10_000 });
        const secret =
          looksLikeSecretField(toLocatorHints(c.hints)) || looksLikeSecretValue(c.value);
        journalAct(c, (target) => ({
          kind: "input",
          target,
          value: secret ? REDACTED : c.value,
          redacted: secret,
        }));
        return { ok: true };
      }
      case "place": {
        const bank = bankCodeSecret(c.secret);
        if (bank) return placeBankCode(c, bank);
        const card = cardSecret(c.secret);
        if (card) return placeCard(c, card, wait);
        const own = profileSecret(c.secret);
        const value = own ? await profileValue(c.secret, own) : await sessionSecret(c.secret);
        const host = new URL(page.url()).host;
        // A profile field is the person's own, not a site's login: any host may have it.
        const allowed = !own && opts.secretHosts ? opts.secretHosts(host, c.secret) : true;
        await opts.audit?.record({
          at: new Date().toISOString(),
          credential: opts.site,
          field: "secret",
          site: opts.site,
          url: urlWithoutQuery(page.url()),
          by: `place ${c.secret}`,
          allowed,
        });
        if (!allowed)
          throw new SecretLeak(
            opts.site,
            host,
            `${c.secret}`,
            "a signup that moves to a parent's identity host lists it in SIGNUP_ALSO_HOSTS",
          );
        await gate("fill", c, wait);
        await hands.think(page);
        // A secret arrives whole, as autofill or a password manager puts it; nobody types a minted password.
        await hands.paste(find(c), value, { timeout: 10_000 });
        journalAct(c, (target) => ({
          kind: "input",
          target,
          value: REDACTED,
          redacted: true,
          secret: c.secret,
        }));
        return { ok: true, secret: c.secret };
      }
      case "select": {
        await gate("select", c, wait);
        await hands.think(page);
        await chooseOption(find(c), c.value, 10_000, hands);
        journalAct(c, (target) => ({ kind: "select", target, value: c.value }));
        return { ok: true };
      }
      case "upload": {
        await fp.act(
          { kind: "upload", files: await uploadFiles(c.files, wait) },
          c.hints as Hints,
          {
            goal: c.goal ?? "upload",
            timeoutMs: 10_000,
          },
        );
        await settle(page);
        journalAct(c, (target) => ({ kind: "upload", target, files: c.files }));
        return { url: page.url() };
      }
      case "press": {
        // Enter or Space on a button is a click: the same gate, the same receipt.
        const spent = activates(c.key) ? await gate("click", c, wait) : null;
        const billing = spent ? await fillBilling() : [];
        await hands.think(page);
        await hands.press(find(c), c.key, { timeout: 10_000 });
        await settle(page);
        journalAct(c, (target) => ({ kind: "press", target, key: c.key }));
        const set = billing.length ? { billing } : {};
        if (spent?.charges) return { url: page.url(), ...set, told: await reportSpend(spent) };
        return { url: page.url(), ...set };
      }
      case "type": {
        // Into the control just clicked: journaled as its input, so the flow types it too.
        const into = lastClick;
        const held = into
          ? await find(into)
              .evaluate(
                (el) =>
                  el === el.ownerDocument.activeElement ||
                  el.contains(el.ownerDocument.activeElement),
                undefined,
                { timeout: 2_000 },
              )
              .catch(() => false)
          : false;
        await hands.type(page, c.text, { timeout: 10_000 });
        if (!into || !held)
          return {
            ok: true,
            journaled: false,
            note: "typed into a focus no clicked control holds: the recording lacks it; use fill",
          };
        const secret =
          looksLikeSecretField(toLocatorHints(into.hints)) || looksLikeSecretValue(c.text);
        journalAct(into, (target) => ({
          kind: "input",
          target,
          value: secret ? REDACTED : c.text,
          redacted: secret,
        }));
        return { ok: true };
      }
      case "key": {
        // Enter or Space presses whatever has focus: judged as a click on it.
        const focused = { ...c, hints: { css: "*:focus" } } as unknown as Target;
        const spent = activates(c.key) ? await gate("click", focused, wait) : null;
        await hands.press(page, c.key, { timeout: 10_000 });
        await settle(page);
        if (spent?.charges) return { url: page.url(), told: await reportSpend(spent) };
        return { url: page.url() };
      }
      case "aria": {
        const tree = await (c.hints
          ? locate(page, c.hints as Hints).ariaSnapshot()
          : ariaWithFrames(page)
        ).catch((e: Error) => `error: ${e.message}`);
        // Even raw: a password typed into a field is never something a caller may read back.
        const aria = out(redactAria(tree.slice(0, c.limit ?? 12_000)), c.raw);
        if (c.hints && tree.startsWith("error:"))
          return { aria, hint: 'see the page: {"cmd":"marks"}' };
        if (!c.extras || c.hints) return { aria };
        const extras = (await extrasOf(page)).map((e) => ({ ...e, name: out(e.name, c.raw) }));
        return { aria, extras };
      }
      case "snapshot":
        return {
          rows: (await snapshotPage(page, c.limit ?? 120))
            .split("\n")
            .map((r) => redactRow(r))
            .join("\n"),
        };
      case "text":
        return {
          text: out(
            c.layout === false
              ? await bodyText(page, c.limit ?? 4_000)
              : await layoutText(page, c.limit ?? 4_000, { coords: c.coords === true }),
            c.raw,
          ),
        };
      case "url":
        return { url: page.url() };
      case "files": {
        if (!opts.files)
          throw new Error("files: none here (they live on the Mac: autobrowse files add)");
        // A session without sets, or `all`, sees every file: sets are a convenience, not a fence.
        const files = c.all || !opts.fileSets?.length ? await opts.files.list() : sessionFiles;
        return {
          files: files.map(fileLine),
          sets: Object.keys(await opts.files.sets()),
          use: 'upload{files:["file:<name>"]}; read_file{name} for a doc\'s text',
        };
      }
      case "read_file": {
        const by = "read_file";
        if (!opts.files)
          throw new Error("read_file: no files here (they live on the Mac: autobrowse files add)");
        const got = await opts.files.get(c.name);
        if (!got) {
          await auditFile(c.name, by, false);
          throw new Error(`read_file: no file ${c.name} (autobrowse files list)`);
        }
        await auditFile(c.name, by, true);
        const f = got.file;
        if (f.kind === "paper") return { name: f.name, text: null, why: "no text: an ID document" };
        if (!f.text) return { name: f.name, text: null, why: "no text: an image or a scan" };
        const limit = c.limit ?? 40_000;
        return {
          name: f.name,
          note: f.note,
          text: f.text.slice(0, limit),
          ...(f.text.length > limit ? { more: f.text.length - limit } : {}),
        };
      }
      case "pages":
        return {
          pages: page
            .context()
            .pages()
            .map((p, i) => ({ index: i, url: p.url(), active: p === page })),
        };
      case "page": {
        const all = page.context().pages();
        const next = c.index === "main" ? all[0] : all[c.index];
        if (!next || next.isClosed()) throw new Error(`no open page ${c.index}`);
        fp.switchTo(next);
        page = next;
        // A popup that closes (OAuth done) hands control back to the main page.
        if (c.index !== "main") next.once("close", () => fp.switchTo(all[0] as Page));
        return { url: next.url() };
      }
      case "screenshot":
        return { file: await shoot() };
      case "marks":
        return takeMarks();
      case "network":
        return network(c);
      case "html":
        return html(c);
      case "eval": {
        // A click by script never meets the click's gate.
        await scriptGate(c.js, wait);
        const result: unknown = c.hints
          ? await locate(page, c.hints as Hints)
              .first()
              // A string is an expression to Playwright, never called: wrap it as a function of el.
              .evaluate(
                new Function("el", `return (${c.js})(el);`) as (el: unknown) => unknown,
                undefined,
                {
                  timeout: 10_000,
                },
              )
          : await inPage(page, c.js);
        // A script that clicked or submitted is an act a walk replays; one that only looked is not.
        if (scriptActs(c.js))
          journal({
            kind: "eval",
            target: c.hints ? toLocatorHints(c.hints) : null,
            js: c.js,
          });
        return { result: typeof result === "string" ? out(result, c.raw) : result };
      }
      case "count":
        return { count: await locateAll(page, c.hints as Hints).count() };
      case "read": {
        const text = (await find(c).first().innerText({ timeout: 10_000 })).trim().slice(0, 2_000);
        const shown = out(text, false);
        journalAct(c, (target) => ({ kind: "read", target, as: c.as, value: shown }));
        return { as: c.as, text: shown };
      }
      case "records": {
        const key = c.key ?? (c.fields[0] as { key: string }).key;
        if (!c.fields.some((f) => f.key === key))
          throw new Error(`records: key ${key} is not a field`);
        const base = {
          as: c.as,
          goal: c.goal,
          fields: c.fields,
          key,
          ...(c.max ? { max: c.max } : {}),
        };
        let op: RecordsOp;
        let rows: Row[];
        if (c.code) {
          op = { kind: "records", ...base, code: c.code, min: 0, sample: [] };
          ({ rows } = await readRecords(fp, op));
          const problem = checkRows(rows, { fields: c.fields, min: c.min === 0 ? 0 : 1 });
          if (problem) throw new Error(`records: ${problem}`);
          op.sample = rows.slice(0, 3);
        } else {
          if (!opts.llm)
            throw new Error("records: send `code`, or set LLM_PROVIDER for a model to write it");
          const w = await writeRecords({ fp, llm: opts.llm, ...base });
          if ("error" in w) throw new Error(`records: ${w.error}`);
          ({ op, rows } = w);
        }
        op.min = c.min ?? Math.max(1, Math.floor(rows.length / 2));
        journal({ kind: "records", op });
        return {
          as: c.as,
          rows: rows.length,
          min: op.min,
          first: out(JSON.stringify(rows.slice(0, 5)), c.raw),
        };
      }
      case "keep": {
        if (!opts.sink) throw new Error("keep needs a secret sink (SECRET_SINK / .env)");
        const value = await textOf(find(c));
        if (!value) throw new Error("keep: the element is empty");
        await opts.sink.put(c.env, value);
        journalAct(c, (target) => ({ kind: "keep", target, env: c.env }));
        return { env: c.env, length: value.length };
      }
      case "captcha": {
        const got = await fp.captcha();
        page = fp.page;
        journal({ kind: "note", text: "solved a captcha here: `await fp.captcha()`" });
        return got;
      }
      case "note":
        journal({ kind: "note", text: c.text });
        return { ok: true };
      case "cut":
        journal({ kind: "cut", name: c.name });
        return { ok: true };
      case "download": {
        if (!c.url && !c.hints) throw new Error("download: give url or hints");
        const got = await fetchFile(page, {
          url: c.url ?? null,
          hints: (c.hints as Hints) ?? null,
        });
        const dir = join(shotsDir, "downloads");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${c.as}-${got.name}`);
        writeFileSync(file, got.buffer);
        journal({
          kind: "download",
          target: c.hints ? toLocatorHints(c.hints) : null,
          href: c.url ?? null,
          as: c.as,
        });
        return { as: c.as, file, bytes: got.buffer.length, type: got.mimeType };
      }
      case "goal":
        logged((h) => h.goal(c.text));
        return { ok: true, run: history?.id ?? null };
      case "done": {
        const id = history && !history.ended() ? history.id : null;
        await endRun(c.outcome, c.summary ?? null);
        return { ok: true, run: id };
      }
      case "os": {
        const a = c.act;
        await gateDesktop(a, wait);
        const result = await runDesktop(desktop, a, shotsDir, shotN++);
        // Looking (apps, tree, shot) is not journaled; acts are, with typed secrets hidden.
        if (a.op !== "apps" && a.op !== "tree" && a.op !== "shot") {
          const redacted = a.op === "type" && (a.secret === true || looksLikeSecretValue(a.text));
          journal({
            kind: "desktop",
            op: redacted && a.op === "type" ? { ...a, text: REDACTED } : a,
            redacted,
          });
        }
        return result;
      }
      case "pause":
        paused = true;
        handActs = 0;
        if (history) lookBefore = await lookAt(page).catch(() => null);
        journal({ kind: "pause" });
        // The page may predate the init script: hook it now.
        await inPage(page, OBSERVER_SCRIPT).catch(() => undefined);
        return { paused: true };
      case "resume": {
        journal({ kind: "resume" });
        resume();
        return { paused: false, handActs };
      }
      case "tools": {
        const all = await toolsNow();
        if (c.find) return { tools: findTools(all.map(findable), c.find).map(brief) };
        if (c.site) return { tools: all.filter((t) => t.site === c.site).map(brief) };
        return { sites: sitesTree(all) };
      }
      case "journal":
        return { total: actions.length, actions: c.last ? actions.slice(-c.last) : actions };
      case "save": {
        const rec: Recording = {
          name: c.name,
          site: opts.site,
          startedAt,
          finishedAt: new Date(now()).toISOString(),
          actions: actions.map((a) =>
            a.screenshot ? { ...a, screenshot: relative(opts.recordingsDir, a.screenshot) } : a,
          ),
          trace: null,
          terminal: null,
          commands: [],
        };
        const dir = await saveRecording(opts.recordingsDir, rec);
        saved = true;
        return { dir, actions: actions.length };
      }
      case "batch": {
        const cmds = c.cmds.map((raw, i) => {
          const one = commandSchema.safeParse(raw);
          if (!one.success) throw new Error(`batch[${i}]: ${one.error.message}`);
          if (UNBATCHABLE.has(one.data.cmd))
            throw new Error(`batch[${i}]: ${one.data.cmd} cannot be batched`);
          return one.data;
        });
        const before = await rows();
        const done: unknown[] = [];
        const answer = async (extra: object) => {
          page = fp.page;
          return { done, ...extra, url: page.url(), changed: pageChange(before, await rows()) };
        };
        for (const [i, one] of cmds.entries()) {
          try {
            if (history && LOOKED_AT.has(one.cmd))
              lookBefore = await lookAt(page).catch(() => null);
            done.push(await act(one, wait));
          } catch (err) {
            // A payment gate answers the whole call, as it does a single act.
            if (err instanceof PaymentGate) throw err;
            const error = err instanceof Error ? err.message.split("\n")[0] : String(err);
            const shot = "hints" in one && missed(err) ? await takeMarks().catch(() => null) : null;
            return answer({
              failed: { at: i, cmd: one.cmd, error },
              ...(shot ? { marks: shot } : {}),
            });
          }
        }
        return answer({});
      }
      case "flow":
        return runWorkflow(c, wait);
      case "code":
        return runCodeHere(c, wait);
      case "close":
        // Closed on purpose: nothing left to resume, unless asked to keep it.
        closing = !c.keep;
        if (c.why) {
          endedBy = "idle";
          closedWhy = c.why;
        }
        if (opts.journalFile && closing) rmSync(opts.journalFile, { force: true });
        if (codeFile && closing) rmSync(codeFile, { force: true });
        await overlay.remove(page);
        queueMicrotask(() => finish());
        return { ok: true };
    }
  };

  const token = randomBytes(16).toString("hex");
  const server: Server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.statusCode = 401;
      res.end('{"error":"bad or missing bearer token"}');
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      res.setHeader("content-type", "application/json");
      let parsed: Command;
      try {
        parsed = commandSchema.parse(JSON.parse(body || "{}"));
      } catch (err) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        return;
      }
      // `?wait=1`: a payment gate holds the request until the person answers (one request, not a
      // resend loop); without it the gate answers 202 at once and the same command re-asks.
      const wait = new URL(req.url ?? "/", "http://x").searchParams.get("wait") === "1";
      const t = now();
      const by = req.headers["x-claude-session"];
      const session = typeof by === "string" && /^[\w-]{8,64}$/.test(by) ? by : undefined;
      try {
        const answer = await run(parsed, wait);
        const body = JSON.stringify(parsed.cmd === "url" ? answer : leanUrls(answer));
        counted(parsed, t, null, body, undefined, session);
        res.end(body);
      } catch (err) {
        res.statusCode = err instanceof PaymentGate ? (err.reason === "asked" ? 202 : 403) : 500;
        const detail = err instanceof Error ? err.message : String(err);
        const error = detail.split("\n")[0];
        // A target the page lacks as named: the picture of what it has, numbered to act on.
        const shot =
          "hints" in parsed && parsed.hints && missed(err)
            ? await run({ cmd: "marks" }).catch(() => null)
            : null;
        const body = JSON.stringify({
          error,
          url: shortUrl(page.url()),
          ...(err instanceof PaymentGate ? { gate: err.gate, reason: err.reason } : {}),
          ...(shot ? { marks: shot, hint: 'act on a mark: "hints":{"mark":n}' } : {}),
        });
        counted(parsed, t, error ?? "", body, detail, session);
        res.end(body);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port, "127.0.0.1", resolve));
  if (opts.tokenFile) {
    mkdirSync(dirname(opts.tokenFile), { recursive: true, mode: 0o700 });
    writeFileSync(opts.tokenFile, token, { mode: 0o600 });
  }
  const idleMs = (opts.idleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
  if (infoFile) {
    // No secret in it: who serves this port, for `autobrowse browsers`. Never idle-closed = held.
    const info: ExploreInfo = {
      port: opts.port,
      pid: process.pid,
      site: opts.site,
      driver: opts.driver ?? "console",
      held: idleMs === 0,
      startedAt,
    };
    writeFileSync(infoFile, JSON.stringify(info), { mode: 0o600 });
  }
  page.context().on("close", () => finish());
  // A page load is a person (or a popup) still at work.
  page.context().on("page", (p) => p.on("framenavigated", touch));
  fp.page.on("framenavigated", touch);
  const idleCheck =
    idleMs > 0
      ? setInterval(
          () => {
            if (busy === 0 && now() - lastTouch >= (paused ? idleMs * 4 : idleMs)) {
              endedBy = "idle";
              finish();
            }
          },
          Math.min(60_000, idleMs),
        )
      : null;
  idleCheck?.unref();
  const ended = done.then(async () => {
    if (idleCheck) clearInterval(idleCheck);
    try {
      writeNet();
    } catch {
      // A full disk loses the log, never the close.
    }
    server.close();
    if (opts.tokenFile) rmSync(opts.tokenFile, { force: true });
    if (infoFile) rmSync(infoFile, { force: true });
    // A recording saved and then closed is a run that did its job; an idle close or a lost browser resumes.
    // A person teaching ends by closing the browser: that run did its job too.
    const closedAs = saved ? "saved" : opts.driver === "person" ? "achieved" : "closed";
    await endRun(endedBy ?? closedAs, closedWhy, !closing).catch(() => undefined);
    finishFlow();
  });
  openRun();
  return {
    port: opts.port,
    token,
    exec: async (c) => {
      const t = now();
      try {
        const answer = await run(c, true);
        counted(c, t, null, JSON.stringify(answer ?? null));
        return answer;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const error = detail.split("\n")[0] ?? "";
        counted(c, t, error, error, detail);
        throw err;
      }
    },
    paused: () => paused,
    resumed: () =>
      paused ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve(),
    done: ended,
    resumedFrom,
    runId: () => (history && !history.ended() ? history.id : null),
    files: sessionFiles.map(fileLine),
  };
}
