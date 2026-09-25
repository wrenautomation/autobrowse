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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { SecretAudit } from "credvault";
import type { Page } from "playwright";
import { z } from "zod";
import { SecretLeak, urlWithoutQuery } from "../auth/guard.js";
import type { SecretValues } from "../auth/signup.js";
import {
  chooseOption,
  defineFlow,
  type FlowPage,
  flowRunner,
  type RunnerOptions,
} from "../browser/flow.js";
import { ariaWithFrames } from "../browser/frames.js";
import { handsFor } from "../browser/human/index.js";
import { type Hints, locate, locateAll, textOf } from "../browser/locate.js";
import { snapshotPage } from "../browser/repair.js";
import { type BrowserOptions, bodyText, looksLikeWall, NeedsHuman } from "../browser/session.js";
import type { SecretSink } from "../deps/sink.js";
import { macDesktop } from "../desktop/mac.js";
import {
  type Desktop,
  type DesktopOp,
  desktopOpSchema,
  noDesktop,
  treeText,
} from "../desktop/types.js";
import {
  type Approver,
  amountNear,
  chargesNow,
  PaymentGate,
  PendingApprovals,
  paymentAmount,
  paymentGate,
} from "../gates/payment.js";
import type { Amount } from "../gates/spend.js";
import { type Charge, type Receipt, receiptOutcome } from "../money/charges.js";
import { ADDRESS_FIELDS, type Address } from "../money/profile.js";
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
  redactText,
} from "../recorder/redact.js";
import { saveRecording } from "../recorder/store.js";
import type { Action, LocatorHints, Recording } from "../recorder/types.js";

const hintsSchema = z.object({
  tag: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  placeholder: z.string().nullable().optional(),
  id: z.string().nullable().optional(),
  testId: z.string().nullable().optional(),
  href: z.string().nullable().optional(),
  inputType: z.string().nullable().optional(),
  css: z.string().nullable().optional(),
  nth: z.number().int().nonnegative().nullable().optional(),
  /** Inside an iframe: its selector chain from the page, as `aria` names it. */
  frame: z.string().nullable().optional(),
});

/** What an act points at: the same hints a flow uses (`css` and `nth` included). */
const targetSchema = z.object({ hints: hintsSchema });

export const commandSchema = z.discriminatedUnion("cmd", [
  z.object({ cmd: z.literal("open"), url: z.string().url() }),
  targetSchema.extend({ cmd: z.literal("click"), goal: z.string().optional() }),
  targetSchema.extend({ cmd: z.literal("fill"), value: z.string(), goal: z.string().optional() }),
  /** Fill a field with a named secret the caller holds (a minted password, a code from the inbox); the value never crosses the socket. */
  targetSchema.extend({
    cmd: z.literal("place"),
    secret: z.string().min(1),
    goal: z.string().optional(),
  }),
  targetSchema.extend({ cmd: z.literal("select"), value: z.string(), goal: z.string().optional() }),
  targetSchema.extend({ cmd: z.literal("press"), key: z.string(), goal: z.string().optional() }),
  targetSchema.extend({
    cmd: z.literal("upload"),
    files: z.array(z.string().min(1)).min(1),
    goal: z.string().optional(),
  }),
  /** Keyboard into whatever is focused; not journaled as a locator act. */
  z.object({ cmd: z.literal("type"), text: z.string() }),
  z.object({ cmd: z.literal("key"), key: z.string() }),
  /** Play/pause for an agent driving this session: a person takes over, then hands back. */
  z.object({ cmd: z.literal("pause") }),
  z.object({ cmd: z.literal("resume") }),
  /** Accessibility tree of the page (or of one locator), capped. */
  z.object({
    cmd: z.literal("aria"),
    hints: hintsSchema.optional(),
    limit: z.number().int().positive().optional(),
    /** Secret-shaped strings are masked unless asked for raw. */
    raw: z.boolean().optional(),
  }),
  /** Interactive elements as one line each, what the repairer sees. */
  z.object({ cmd: z.literal("snapshot"), limit: z.number().int().positive().optional() }),
  z.object({
    cmd: z.literal("text"),
    limit: z.number().int().positive().optional(),
    raw: z.boolean().optional(),
  }),
  z.object({ cmd: z.literal("url") }),
  /** Every open page (an OAuth popup beside the main one); `page` switches to one by index, "main" returns. */
  z.object({ cmd: z.literal("pages") }),
  z.object({
    cmd: z.literal("page"),
    index: z.union([z.number().int().min(0), z.literal("main")]),
  }),
  z.object({ cmd: z.literal("screenshot") }),
  /** With `hints`, `js` is a function of that element, run in its frame (`el => el.className`). */
  z.object({
    cmd: z.literal("eval"),
    js: z.string(),
    raw: z.boolean().optional(),
    hints: hintsSchema.optional(),
  }),
  targetSchema.extend({ cmd: z.literal("count") }),
  /** Read an element's text and keep it under `as`; journaled, so the compiled flow reads it too. */
  targetSchema.extend({ cmd: z.literal("read"), as: z.string().regex(/^[a-z][a-zA-Z0-9]*$/) }),
  /** Read a secret the site just minted straight into the secret sink under `env`; nothing shows it. */
  targetSchema.extend({ cmd: z.literal("keep"), env: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }),
  z.object({ cmd: z.literal("note"), text: z.string() }),
  /** Write the journal as a recording under `recordingsDir/<name>`. */
  z.object({ cmd: z.literal("save"), name: z.string().regex(/^[a-z][a-z0-9-]*$/) }),
  /** What is recorded so far; `last` = only the newest n. */
  z.object({ cmd: z.literal("journal"), last: z.number().int().positive().optional() }),
  /** An act on the desktop, outside the browser: apps, menus, keys, a root command. */
  z.object({ cmd: z.literal("os"), act: desktopOpSchema }),
  z.object({ cmd: z.literal("close") }),
]);
export type Command = z.infer<typeof commandSchema>;

/** An action minus what the journal fills in, per union member. */
type Journaled = Action extends infer A ? (A extends Action ? Omit<A, "t" | "url"> : never) : never;

export interface ExploreOptions {
  site: string;
  browser: BrowserOptions;
  recordingsDir: string;
  port: number;
  /** The runner's login hook: a wall on `open` is signed through with stored credentials. */
  login?: RunnerOptions["login"];
  /** Delays around acts; null (the default) answers a console at once, an agent passes human pace. */
  pace?: RunnerOptions["pace"];
  /** The desktop `os` acts run on; this Mac by default, none on a headless host. */
  desktop?: Desktop;
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
  }) => Promise<Card & { billing?: Address }>;
  /**
   * Which card each host was given: written when a card is placed, read when a
   * site charges the card it keeps, so every charge names its card's ending.
   */
  cardsOnFile?: {
    placed(row: { at: string; site: string; host: string; card: string }): Promise<unknown>;
    on(host: string): Promise<string | null>;
  };
  /** Each spending click a person said yes to, with its receipt page: texted, emailed, written down. */
  charges?: (c: Charge, r: Receipt) => Promise<string[]>;
  /** Where every `place` is recorded (allowed or refused); never the value. */
  audit?: SecretAudit;
  /**
   * Who says yes to a billing field or a button that spends. Without one
   * such acts are refused: money is never a session's own call.
   */
  approve?: Approver;
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
  now?: () => number;
}

export const DEFAULT_IDLE_MINUTES = 30;

/** The token file the CLI uses for a port: `$TMPDIR/autobrowse/explore-<port>.token`. */
export const tokenFileFor = (port: number): string =>
  join(tmpdir(), "autobrowse", `explore-${port}.token`);

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
}
export type ExploreCommand = Command;

const toLocatorHints = (h: z.infer<typeof hintsSchema>): LocatorHints => ({
  tag: h.tag ?? "",
  role: h.role ?? null,
  name: h.name ?? null,
  text: h.text ?? null,
  placeholder: h.placeholder ?? null,
  id: h.id ?? null,
  testId: h.testId ?? null,
  href: h.href ?? null,
  inputType: h.inputType ?? null,
  ...(h.css ? { css: h.css } : {}),
  ...(h.nth ? { nth: h.nth } : {}),
  ...(h.frame ? { frame: h.frame } : {}),
});

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

/**
 * Explore runs as one long flow: the runner owns the session, so a login
 * wall on `open` is signed through, popups are tracked, and the profile
 * is the same one the compiled flow will use.
 */
export async function startExplore(opts: ExploreOptions): Promise<Explorer> {
  const ready = new Promise<{ fp: FlowPage; finish: () => void }>((resolve) => {
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
      ...(opts.login ? { login: opts.login } : {}),
    });
    void runner.run(flow, undefined).catch(() => undefined);
  });
  const { fp, finish: finishFlow } = await ready;
  return serve(opts, fp, finishFlow);
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
): Promise<Explorer> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const startedAt = new Date(t0).toISOString();
  const actions: Action[] = [];
  const shotsDir = join(opts.recordingsDir, `.explore-${opts.site}`);
  mkdirSync(shotsDir, { recursive: true });
  const desktop = opts.desktop ?? (process.platform === "darwin" ? macDesktop() : noDesktop());
  let shotN = 0;
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  /** The active page: it moves when a popup opens (OAuth) and comes back after; re-read per command. */
  let page: Page = fp.page;
  let paused = false;
  let waiters: Array<() => void> = [];
  /** Acts a person did by hand since the last `pause`. */
  let handActs = 0;
  const resume = () => {
    paused = false;
    for (const w of waiters) w();
    waiters = [];
  };

  const shoot = async (): Promise<string> => {
    const file = join(shotsDir, `${String(shotN++).padStart(4, "0")}.png`);
    // A failed shot is an error, never a path to a file that is not there.
    await page.screenshot({ path: file });
    return file;
  };
  const journal = (a: Journaled) =>
    actions.push({ ...a, t: now() - t0, url: page.url() } as Action);
  // While paused, the page reports what a person does (the recorder's
  // observer), so hand-done steps sit in the same journal as the
  // commands. Un-paused, commands journal themselves and the DOM is quiet.
  await page
    .context()
    .exposeBinding(BINDING, (_src, raw: RawAction) => {
      if (!paused) return;
      handActs++;
      journal(redactRaw(raw));
    })
    .catch(() => undefined);
  await page
    .context()
    .addInitScript(OBSERVER_SCRIPT)
    .catch(() => undefined);
  page.on("framenavigated", (frame) => {
    if (paused && frame === page.mainFrame()) journal({ kind: "navigate" });
  });

  type Target = z.infer<typeof targetSchema>;
  const find = (t: Target) => locate(page, t.hints as Hints);
  /**
   * Billing fields and spending buttons wait for the person; refused when
   * nobody can be asked. Over the socket the question is asked once and the
   * same command is sent again after the reply (`reason: "asked"`); in
   * process the caller waits.
   */
  const approvals = opts.approve ? new PendingApprovals(opts.approve) : null;
  const decide = async (
    key: string,
    what: string,
    url: string,
    wait: boolean,
    amount: Amount | null = null,
  ) => {
    if (!approvals) throw new PaymentGate(what, "no-approver");
    await approvals.decide(
      key,
      { what, url, site: opts.site, ...(amount ? { amount } : {}) },
      wait,
    );
  };
  /** Instant for a console; a person's hands when an agent drives (`pace`). */
  const hands = handsFor(opts.pace ?? null);
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
  /** Card-and-host pairs a person said yes to this session; the card last placed, for the receipt. */
  const cardsYes = new Set<string>();
  let placedCard: { line: string; recurring: boolean } | null = null;
  const pageText = async () => (await page.innerText("body").catch(() => "")).slice(0, 20_000);
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
    let card: Card & { billing?: Address };
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
    placedCard = { line: cardEnding(card), recurring };
    return { ok: true, secret: c.secret };
  };
  /** After a yes and the click: the page it landed on is the receipt. A failed report never fails the click. */
  const reportSpend = async (spent: { what: string; amount: Amount | null }) => {
    if (!opts.charges) return [];
    const whole = await pageText();
    const text = redactText(whole).slice(0, 6_000);
    const png = await page.screenshot({ fullPage: true, timeout: 15_000 }).catch(() => undefined);
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
  const journalAct = (t: Target, act: (target: LocatorHints) => Journaled) =>
    journal(act(toLocatorHints(t.hints)));
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
  ]);
  let chain: Promise<unknown> = Promise.resolve();
  let lastTouch = now();
  const run = (c: Command, wait = false): Promise<unknown> => {
    lastTouch = now();
    if (IMMEDIATE.has(c.cmd)) return runOne(c, wait);
    const next = chain.then(() => runOne(c, wait));
    chain = next.catch(() => undefined);
    return next;
  };
  const runOne = async (c: Command, wait: boolean): Promise<unknown> => {
    page = fp.page;
    switch (c.cmd) {
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
        await hands.think(page);
        await hands.click(find(c), { timeout: 10_000 });
        await settle(page);
        journalAct(c, (target) => ({ kind: "click", target }));
        // A receipt only for the click that takes money; checkout or "add a card" only led there.
        if (spent?.charges) return { url: page.url(), told: await reportSpend(spent) };
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
        const card = cardSecret(c.secret);
        if (card) return placeCard(c, card, wait);
        if (!opts.secrets) throw new Error("place needs secrets (a signup or a login gives them)");
        const value = await opts.secrets(c.secret);
        if (!value)
          throw new Error(
            `place: ${c.secret} is not available now (a code: the site's message has not arrived in the inbox this run reads; else no secret has that name)`,
          );
        const host = new URL(page.url()).host;
        const allowed = opts.secretHosts ? opts.secretHosts(host, c.secret) : true;
        await opts.audit?.record({
          at: new Date().toISOString(),
          credential: opts.site,
          field: "secret",
          site: opts.site,
          url: urlWithoutQuery(page.url()),
          by: `place ${c.secret}`,
          allowed,
        });
        if (!allowed) throw new SecretLeak(`${opts.site} (${c.secret})`, host);
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
        await chooseOption(page, find(c), c.value, 10_000, hands);
        journalAct(c, (target) => ({ kind: "select", target, value: c.value }));
        return { ok: true };
      }
      case "upload": {
        await fp.act({ kind: "upload", files: c.files }, c.hints as Hints, {
          goal: c.goal ?? "upload",
          timeoutMs: 10_000,
        });
        await settle(page);
        journalAct(c, (target) => ({ kind: "upload", target, files: c.files }));
        return { url: page.url() };
      }
      case "press": {
        await hands.think(page);
        await hands.press(find(c), c.key, { timeout: 10_000 });
        await settle(page);
        journalAct(c, (target) => ({ kind: "press", target, key: c.key }));
        return { url: page.url() };
      }
      case "type":
        await hands.type(page, c.text, { timeout: 10_000 });
        return { ok: true };
      case "key":
        await hands.press(page, c.key, { timeout: 10_000 });
        await settle(page);
        return { url: page.url() };
      case "aria": {
        const tree = await (c.hints
          ? locate(page, c.hints as Hints).ariaSnapshot()
          : ariaWithFrames(page)
        ).catch((e: Error) => `error: ${e.message}`);
        // Even raw: a password typed into a field is never something a caller may read back.
        return { aria: out(redactAria(tree.slice(0, c.limit ?? 12_000)), c.raw) };
      }
      case "snapshot":
        return { rows: await snapshotPage(page, c.limit ?? 120) };
      case "text":
        return { text: out(await bodyText(page, c.limit ?? 4_000), c.raw) };
      case "url":
        return { url: page.url() };
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
      case "eval": {
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
          : await page.evaluate(c.js);
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
      case "keep": {
        if (!opts.sink) throw new Error("keep needs a secret sink (SECRET_SINK / .env)");
        const value = await textOf(find(c));
        if (!value) throw new Error("keep: the element is empty");
        await opts.sink.put(c.env, value);
        journalAct(c, (target) => ({ kind: "keep", target, env: c.env }));
        return { env: c.env, length: value.length };
      }
      case "note":
        journal({ kind: "note", text: c.text });
        return { ok: true };
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
        journal({ kind: "pause" });
        // The page may predate the init script: hook it now.
        await page.evaluate(OBSERVER_SCRIPT).catch(() => undefined);
        return { paused: true };
      case "resume": {
        journal({ kind: "resume" });
        resume();
        return { paused: false, handActs };
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
        return { dir, actions: actions.length };
      }
      case "close":
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
      try {
        res.end(JSON.stringify(await run(parsed, wait)));
      } catch (err) {
        res.statusCode = err instanceof PaymentGate ? (err.reason === "asked" ? 202 : 403) : 500;
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message.split("\n")[0] : String(err),
            url: page.url(),
            ...(err instanceof PaymentGate ? { gate: err.gate, reason: err.reason } : {}),
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port, "127.0.0.1", resolve));
  if (opts.tokenFile) {
    mkdirSync(dirname(opts.tokenFile), { recursive: true, mode: 0o700 });
    writeFileSync(opts.tokenFile, token, { mode: 0o600 });
  }
  page.context().on("close", () => finish());
  // A page load is a person (or a popup) still at work.
  page.context().on("page", (p) => p.on("framenavigated", () => (lastTouch = now())));
  fp.page.on("framenavigated", () => (lastTouch = now()));
  const idleMs = (opts.idleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
  const idleCheck =
    idleMs > 0
      ? setInterval(
          () => {
            if (now() - lastTouch >= (paused ? idleMs * 4 : idleMs)) finish();
          },
          Math.min(60_000, idleMs),
        )
      : null;
  idleCheck?.unref();
  void done.then(() => {
    if (idleCheck) clearInterval(idleCheck);
    server.close();
    if (opts.tokenFile) rmSync(opts.tokenFile, { force: true });
    finishFlow();
  });
  return {
    port: opts.port,
    token,
    exec: (c) => run(c, true),
    paused: () => paused,
    resumed: () =>
      paused ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve(),
    done,
  };
}
