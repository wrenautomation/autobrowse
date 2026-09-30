/**
 * Screens: what a page is, and what to do on it. A screen is known by its
 * URL and landmarks (plain checks, no model) and has one handler (plain
 * code). Two uses:
 *
 * - Interrupts: screens that can show up in any flow (a cookie banner, a
 *   screen a repair once clicked past). When a step's control is not on the
 *   page, the runner looks for one, handles it, and the step goes on. Every
 *   flow gets them; none is rewritten.
 * - Walks: a flow whose path branches (a sign-in) is its screens and a
 *   goal, not a script. The walker looks, picks the screen, runs its
 *   handler, and looks again until the goal. The same screen three times
 *   running is stuck.
 *
 * A page no screen knows goes down a ladder: screens learned on this site
 * (plain data, kept from an earlier answer), then a model asked to name the
 * screen from the walk's own list, or one click past it that commits
 * nothing; then the walk fails. The model never acts: it picks, and a
 * handler or a recorded click does the rest. What it picked is kept, so the
 * next run needs no model (designs/2026-09-27-screens.md).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Page } from "playwright";
import type { FlowPage } from "./flow.js";
import type { Hints } from "./locate.js";
import { COMMITTING } from "./repair.js";

/** What a screen's checks and handler get: the page, and whatever the walk carries (a credential). */
export interface ScreenCtx {
  fp: FlowPage;
}

export interface Screen<C extends ScreenCtx = ScreenCtx> {
  /** Unique within its walk: "saved profile". */
  name: string;
  /** One line a person would say about it: what a model picks by. */
  looks: string;
  /** The URL it lives on. */
  at?: RegExp;
  /** All visible: it is this screen. */
  shows?: readonly Hints[];
  /** None visible (a dashboard has no password box). Not a check on its own. */
  hides?: readonly Hints[];
  /** The page's text says this. Costs a text read: pair it with `at` or `shows`. */
  says?: RegExp;
  /** Anything else the page must be. */
  is?(c: C): Promise<boolean>;
  /** What to do here. Absent on the goal. */
  act?(c: C): Promise<void>;
  /** The walk ends here. */
  goal?: boolean;
  /** An interrupt checked on a page's first act even when the control shows: it may sit on top (a cookie banner). */
  overlay?: boolean;
  /** It may come back (a next page): again on a new URL is not stuck, and a new URL is leaving it. */
  repeats?: boolean;
}

/** A page by its shape: host and path (ids as `*`), and the headings, buttons and fields it shows. */
export interface PageLook {
  url: string;
  landmarks: string[];
}

/** A page seen before on a site, and what worked on it. */
export interface LearnedScreen {
  /** Base site: `x@wren` and `x` share it. */
  site: string;
  url: string;
  /** All shown: it is this page. */
  landmarks: string[];
  /** A walk's screen, by name. */
  walk?: string;
  screen?: string;
  /** Or one click that gets past it: an interrupt in every flow on the site. */
  click?: Hints;
  reason: string;
  found: string;
  used: number;
  lastUsed?: string;
}

export interface LearnedScreens {
  /** What worked on this page before: a walk's screen when `walk` is given, else only clicks. */
  find(site: string, walk: string | null, look: PageLook): LearnedScreen | null;
  /** Whether anything is kept for the site: the runner looks at the page only then. */
  has(site: string): boolean;
  keep(row: Omit<LearnedScreen, "found" | "used">): void;
  used(row: LearnedScreen): void;
  drop(row: LearnedScreen): void;
  flush(): void;
  list(): LearnedScreen[];
  /** Drop a site's rows. Returns how many. */
  forget(site: string): number;
}

/** A model's answer about an unknown page: one of the walk's screens, or one click past it. */
export interface ScreenReading {
  screen?: string;
  click?: Hints;
  reason: string;
}

export interface ScreenReader {
  readonly id: string;
  read(req: {
    goal: string;
    url: string;
    /** Interactive elements, one per line. */
    snapshot: string;
    known: { name: string; looks: string }[];
  }): Promise<ScreenReading | null>;
}

/** What the runner gives a walk: the live page's shape, the kept rows, the model. */
export interface ScreenHelp {
  look(): Promise<PageLook>;
  snapshot(): Promise<string>;
  learned: LearnedScreens;
  reader: ScreenReader | null;
}

const base = (site: string) => site.split("@")[0] ?? site;

/** A learned page is matched by at most this many landmarks: enough to tell it apart, few enough to survive a tweak. */
const KEEP_LANDMARKS = 8;
/** A page with fewer landmarks than this is too bare to learn. */
const MIN_LANDMARKS = 2;
/** Most rows kept; the oldest go first. A learned screen belongs in the source, not here for good. */
const LIMIT = 500;

function table(
  load: () => LearnedScreen[],
  save: (rows: LearnedScreen[]) => void,
  now: () => Date,
): LearnedScreens {
  let rows: LearnedScreen[] | null = null;
  const all = () => {
    rows ??= load();
    return rows;
  };
  let dirty = false;
  const write = () => {
    dirty = false;
    rows = all().slice(-LIMIT);
    save(rows);
  };
  const same = (a: LearnedScreen, b: Omit<LearnedScreen, "found" | "used">) =>
    a.site === b.site &&
    a.url === b.url &&
    a.walk === b.walk &&
    a.landmarks.join("\n") === b.landmarks.join("\n");
  return {
    find(site, walk, look) {
      const shown = new Set(look.landmarks);
      let best: LearnedScreen | null = null;
      for (const r of all()) {
        if (r.site !== base(site) || r.url !== look.url) continue;
        if (r.screen ? r.walk !== walk : !r.click) continue;
        if (!r.landmarks.every((l) => shown.has(l))) continue;
        // A walk's own screen over a click; then the row that names the page most closely.
        const score = (x: LearnedScreen) => (x.screen ? 1_000 : 0) + x.landmarks.length;
        if (!best || score(r) > score(best)) best = r;
      }
      return best;
    },
    has: (site) => all().some((r) => r.site === base(site)),
    keep(row) {
      if (row.landmarks.length < MIN_LANDMARKS) return;
      const kept = { ...row, site: base(row.site), found: now().toISOString(), used: 0 };
      rows = [...all().filter((r) => !same(r, kept)), kept];
      write();
    },
    used(row) {
      row.used += 1;
      row.lastUsed = now().toISOString();
      dirty = true;
    },
    drop(row) {
      rows = all().filter((r) => r !== row);
      write();
    },
    flush() {
      if (dirty) write();
    },
    list: () => all(),
    forget(site) {
      const before = all().length;
      rows = all().filter((r) => r.site !== base(site));
      const n = before - rows.length;
      if (n) write();
      return n;
    },
  };
}

export function fileScreens(path: string, now: () => Date = () => new Date()): LearnedScreens {
  return table(
    () => {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as LearnedScreen[];
      } catch {
        return [];
      }
    },
    (rows) => {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(rows, null, 1)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    },
    now,
  );
}

export function memoryScreens(now: () => Date = () => new Date()): LearnedScreens {
  let kept: LearnedScreen[] = [];
  return table(
    () => kept,
    (rows) => {
      kept = rows;
    },
    now,
  );
}

/** `https://dash.x.com/4f3a…/home?q=1` → `dash.x.com/*\/home`: ids and numbers as `*`. */
export function urlShape(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split("/")
      .map((s) => (/^(\d+|[0-9a-f]{8,}|[0-9a-f-]{32,}|[A-Za-z0-9_-]{24,})$/i.test(s) ? "*" : s))
      .join("/");
    return `${u.host}${path.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}

/** A landmark as kept: lowercase, addresses and numbers blurred, so a greeting by name still matches. */
export const landmark = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\s@]+@[^\s@]+/g, "<address>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

/**
 * Visible headings, buttons and fields by their names, headings first. Plain
 * JS: it runs in the page. A field is named by its label, never its value:
 * what a person typed (a password) must not become a landmark.
 */
const LANDMARK_SCRIPT = `() => {
  const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const said = (e) => clean(e.getAttribute("aria-label") || e.getAttribute("placeholder") || e.textContent || (e.type === "submit" || e.type === "button" ? e.value : ""));
  const label = (e) => clean(e.getAttribute("aria-label") || e.getAttribute("placeholder") || (e.labels && e.labels[0] && e.labels[0].textContent) || e.getAttribute("name") || e.getAttribute("type") || e.tagName.toLowerCase());
  const out = [];
  for (const e of document.querySelectorAll("h1, h2, h3, [role=heading]")) if (seen(e) && said(e)) out.push("heading " + said(e));
  for (const e of document.querySelectorAll("button, [role=button], input[type=submit]")) if (seen(e) && said(e)) out.push("button " + said(e));
  for (const e of document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), textarea")) if (seen(e)) out.push("field " + label(e));
  return out.slice(0, 60);
}`;

export async function lookAt(page: Page): Promise<PageLook> {
  const raw = await page.evaluate<string[]>(`(${LANDMARK_SCRIPT})()`).catch(() => [] as string[]);
  return { url: urlShape(page.url()), landmarks: [...new Set(raw.map(landmark))] };
}

/** The landmarks a learned row keeps: headings first, as the page lists them. */
export const keepOf = (look: PageLook): string[] => look.landmarks.slice(0, KEEP_LANDMARKS);

const once = <T>(f: () => Promise<T>) => {
  let p: Promise<T> | null = null;
  return () => {
    p ??= f();
    return p;
  };
};

export async function isOn<C extends ScreenCtx>(
  s: Screen<C>,
  c: C,
  text: () => Promise<string> = () => c.fp.text(),
): Promise<boolean> {
  const { fp } = c;
  // A screen with nothing to check is no screen: it would match every page.
  if (!s.at && !s.shows?.length && !s.says && !s.is) return false;
  if (s.at && !s.at.test(fp.url())) return false;
  for (const h of s.shows ?? []) if (!(await fp.has(h))) return false;
  for (const h of s.hides ?? []) if (await fp.has(h)) return false;
  if (s.says && !s.says.test(await text())) return false;
  return s.is ? s.is(c) : true;
}

const POLL_MS = 500;
/** How long a page gets to become a known screen before it counts as unknown. */
const RENDER_POLLS = 16;
/** How long a handler's page gets to move on before the walk looks again. */
const LEAVE_POLLS = 20;
const MAX_STEPS = 12;

/** The first screen the page is, in order; looked for again while the page renders. */
export async function observe<C extends ScreenCtx>(
  c: C,
  screens: readonly Screen<C>[],
  polls = RENDER_POLLS,
): Promise<Screen<C> | null> {
  for (let n = 0; ; n++) {
    const text = once(() => c.fp.text());
    for (const s of screens) if (await isOn(s, c, text)) return s;
    if (n >= polls) return null;
    await c.fp.wait(POLL_MS);
  }
}

/** Until the page is no longer this screen; false when it stays. */
async function leave<C extends ScreenCtx>(c: C, s: Screen<C>, from: string): Promise<boolean> {
  for (let n = 0; n < LEAVE_POLLS; n++) {
    if ((s.repeats && c.fp.url() !== from) || !(await isOn(s, c))) return true;
    await c.fp.wait(POLL_MS);
  }
  return false;
}

export interface Walk<C extends ScreenCtx> {
  /** Learned screens are kept by site. */
  site: string;
  /** Unique on the site: "sign-in". */
  name: string;
  /** In words, for the model and the person: "signed in to the dashboard". */
  goal: string;
  /** In order: the first that matches is the page. Goals first, forms last. */
  screens: readonly Screen<C>[];
  /** Screens passed before giving up; default 12. */
  maxSteps?: number;
  /** How the walk fails (stuck, unknown page); default: to a person. */
  fail?(reason: string): never;
}

/** An unknown page, answered: the screen to treat it as, and what to keep once it worked. */
interface Answer<C extends ScreenCtx> {
  screen: Screen<C>;
  worked?(): void;
  failed?(): void;
}

/** One click, as a screen: a learned detour or a model's. It is there while its control is. */
const clickScreen = <C extends ScreenCtx>(name: string, click: Hints): Screen<C> => ({
  name,
  looks: name,
  shows: [click],
  act: ({ fp }) => fp.act({ kind: "click" }, click, { goal: name }),
});

const commits = (h: Hints) => COMMITTING.test(`${h.name ?? ""} ${h.text ?? ""}`);

async function unknown<C extends ScreenCtx>(
  c: C,
  w: Walk<C>,
  fail: (reason: string) => never,
): Promise<Answer<C>> {
  const { fp } = c;
  const help = fp.screens;
  const known = w.screens.filter((s) => s.act || s.goal);
  const lost = () => fail(`a page ${w.name} does not know: ${fp.url()}`);
  if (!help) return lost();
  const look = await help.look();
  const kept = help.learned.find(w.site, w.name, look);
  const byName = (name: string | undefined) => known.find((s) => s.name === name);
  if (kept) {
    const screen = kept.screen
      ? byName(kept.screen)
      : kept.click && clickScreen<C>(`learned click on ${look.url}`, kept.click);
    if (screen)
      return {
        screen,
        worked: () => help.learned.used(kept),
        failed: () => help.learned.drop(kept),
      };
  }
  if (!help.reader) return lost();
  const reading = await help.reader.read({
    goal: w.goal,
    url: fp.url(),
    snapshot: await help.snapshot(),
    known: known.map((s) => ({ name: s.name, looks: s.looks })),
  });
  const row = { site: w.site, url: look.url, landmarks: keepOf(look), reason: "" };
  const named = byName(reading?.screen);
  if (reading && named)
    return {
      screen: named,
      worked: () =>
        help.learned.keep({ ...row, walk: w.name, screen: named.name, reason: reading.reason }),
    };
  if (reading?.click && !commits(reading.click))
    return {
      screen: clickScreen<C>(`click past ${look.url}`, reading.click),
      worked: () =>
        help.learned.keep({
          ...row,
          click: reading.click as Hints,
          reason: reading.reason,
        }),
    };
  return lost();
}

/**
 * Walk the screens until the goal: look, act, look again. A provider's
 * popup that closed itself hands the walk back to the page that opened it.
 * Returns the goal screen's name.
 */
export async function walk<C extends ScreenCtx>(c: C, w: Walk<C>): Promise<string> {
  const { fp } = c;
  const main = fp.page;
  const fail = w.fail ?? ((reason: string) => fp.human(reason));
  const path: string[] = [];
  const urls: string[] = [];
  for (let step = 0; step < (w.maxSteps ?? MAX_STEPS); step++) {
    if (fp.page !== main && fp.page.isClosed?.()) fp.switchTo(main);
    const seen = await observe(c, w.screens);
    const answer: Answer<C> = seen ? { screen: seen } : await unknown(c, w, fail);
    const s = answer.screen;
    if (s.goal) return s.name;
    const at = fp.url();
    if (
      path.length >= 2 &&
      path.at(-1) === s.name &&
      path.at(-2) === s.name &&
      !(s.repeats && urls.at(-1) !== at)
    )
      fail(`stuck on "${s.name}" at ${at}`);
    path.push(s.name);
    urls.push(at);
    try {
      await s.act?.(c);
    } catch (err) {
      answer.failed?.();
      throw err;
    }
    // Kept only once the page moved on: an answer that changed nothing taught nothing.
    if ((await leave(c, s, at)) || fp.page.isClosed?.()) answer.worked?.();
  }
  return fail(`no ${w.goal} after ${path.join(" → ")}`);
}

/** Click something that may open a popup (an OAuth button): the walk acts on the popup from then on. */
export async function clickOpening(fp: FlowPage, hints: Hints, goal: string): Promise<void> {
  const popup = fp.nextPage(8_000);
  await fp.act({ kind: "click" }, hints, { goal });
  const page = await popup;
  if (page) fp.switchTo(page);
}

/** Back from a popup to the page that opened it, once the popup closes itself. */
export async function backFrom(fp: FlowPage, main: Page, timeoutMs = 30_000): Promise<void> {
  if (fp.page === main) return;
  if (!fp.page.isClosed?.())
    await fp.page.waitForEvent?.("close", { timeout: timeoutMs }).catch(() => undefined);
  fp.switchTo(main);
}

/**
 * A cookie banner: its box mentions cookies, its button declines or
 * accepts. Declined when the banner offers it.
 */
const CONSENT_BOX =
  ':is([role=dialog], [aria-modal=true], [id*=cookie i], [class*=cookie i], [id*=consent i], [class*=consent i]):has-text("cookie")';
const CONSENT_BUTTON = (words: string) =>
  `${CONSENT_BOX} :is(button, [role=button]):text-matches("${words}", "i")`;
const COOKIE_DECLINE: Hints = {
  css: CONSENT_BUTTON(
    "^(reject|decline|deny)( all)?( cookies)?$|^(only|use) (strictly )?necessary|necessary (cookies )?only",
  ),
};
const COOKIE_ACCEPT: Hints = {
  css: CONSENT_BUTTON("^(accept|allow|agree|ok|got it)( all)?( cookies)?$"),
};

/** Interrupts every flow gets. Each is non-committing: it dismisses, declines or picks. */
export const INTERRUPTS: readonly Screen[] = [
  {
    name: "cookie banner",
    looks: "a cookie consent banner or dialog",
    overlay: true,
    is: async ({ fp }) => (await fp.has(COOKIE_DECLINE)) || (await fp.has(COOKIE_ACCEPT)),
    act: async ({ fp }) =>
      fp.act({ kind: "click" }, (await fp.has(COOKIE_DECLINE)) ? COOKIE_DECLINE : COOKIE_ACCEPT, {
        goal: "dismiss the cookie banner",
      }),
  },
];
