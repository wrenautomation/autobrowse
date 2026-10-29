/**
 * Human hands: the one door every browser act goes through.
 *
 * A flow, a compiled workflow, the explore console and the agent all say
 * the same four things — think, click, type, press — and `Hands` decides
 * how a person would do them. Sites watch for the other kind: instant
 * clicks on the exact centre, a pointer that teleports, every key 50ms
 * apart. So:
 *
 *   think  a pause to read the page; sometimes the hand wanders meanwhile,
 *          a few stops near and far, trembling as a hand does
 *   click  a control off screen is wheeled to, flick by flick; then a
 *          curved, eased reach to a spot near the middle of the control,
 *          sometimes stopping part way; a beat of hover, the button held
 *          down a moment. Every pause drifts a pixel or so, as a resting
 *          hand does
 *   type   runs of fast and slow keys, beats between words and after
 *          punctuation, the odd stall mid-word, the odd slip onto the key
 *          next door, backed out with Backspace; long text is pasted
 *   press  one key, held down like a key is
 *   paste  a value that arrives whole, as autofill or a password manager
 *          puts it: the field clicked, a beat, the text in at once
 *
 * The details live beside this file (typing.ts, mouse.ts, scroll.ts, draw.ts) as
 * pure plans with no page in them; this file only plays them. Every click
 * still ends in Playwright's own click at the chosen spot, so its checks
 * (visible, enabled, not covered, inside an iframe) stand; any trouble in
 * the human part falls back to the plain act, never to a failure.
 *
 * `handsFor(null)` is instant hands: demos, tests, a console answering at once.
 * `handsFor(pace, random, log)` also says each act to `log` as it happens (a
 * pointer step, a press, a key, a wheel step), on the epoch-ms clock: a film
 * draws its cursor and plays its sounds from that (`browser/film.ts`). Each key
 * of a text `hidden` names (a password) goes to `log` as `•`.
 * `showPointer` draws the pointer on the page (a dot), to watch a headed run;
 * it puts an element in the page, so it is for watching, never for real runs.
 *
 * This folder imports nothing from autobrowse: only Playwright's types.
 */
import type { Locator, Page } from "playwright";
import { chance, drawMs, type Random } from "./draw.js";
import {
  aimPoint,
  type Box,
  type MouseStyle,
  mousePath,
  type Point,
  restAt,
  wanderPath,
} from "./mouse.js";
import { type ScrollStyle, wheelPlan } from "./scroll.js";
import { BACKSPACE, type TypingStyle, typingPlan } from "./typing.js";

export { drawMs, freshSeed, seeded } from "./draw.js";
export type { MouseStyle, PathStep } from "./mouse.js";
export { aimPoint, mousePath, restAt, tremor, wanderPath } from "./mouse.js";
export type { ScrollStyle, WheelStep } from "./scroll.js";
export { wheelPlan } from "./scroll.js";
export type { Keystroke, TypingStyle } from "./typing.js";
export { BACKSPACE, typingPlan } from "./typing.js";

export interface Pace {
  /** Reading the page before an act, ms. */
  think: [number, number];
  /** Chance the hand drifts while thinking. */
  drift: number;
  typing: TypingStyle;
  mouse: MouseStyle;
  scroll: ScrollStyle;
  /** Draw the pointer on the page, to watch a headed run. */
  showPointer?: boolean;
}

/** A careful person's timings; `HUMAN_PACE` is this, brisker. */
export const CALM_PACE: Pace = {
  think: [350, 1_600],
  drift: 0.35,
  typing: {
    hold: [45, 120],
    gap: [55, 170],
    run: [3, 11],
    tempo: [0.55, 1.9],
    wordBeat: 0.18,
    beat: [180, 900],
    stall: 0.015,
    stallMs: [500, 1_800],
    pasteOver: 400,
    typo: 0.025,
    typoRun: [1, 3],
    notice: [180, 650],
    erase: [70, 160],
  },
  mouse: {
    reach: [90, 170],
    perBit: [80, 140],
    overshoot: 0.2,
    overshootBy: [0.03, 0.09],
    hover: [70, 260],
    hold: [45, 130],
    tremor: 0.8,
    wanderStops: [1, 4],
    wanderRest: [60, 700],
    hesitate: 0.2,
    hesitateMs: [80, 450],
    jitter: 0.6,
    jitterGap: [30, 200],
  },
  scroll: {
    notch: [85, 125],
    flick: [2, 6],
    gap: [18, 70],
    look: [250, 1_100],
    most: 6_000,
  },
};

type Range = [number, number];
const by = (r: Range, k: number): Range => [Math.round(r[0] / k), Math.round(r[1] / k)];

/** Every ms range `k` times shorter; chances, counts and pixels stay, so the shape a site watches is the same. */
export function brisk(p: Pace, k: number): Pace {
  const t = p.typing;
  const m = p.mouse;
  const s = p.scroll;
  return {
    ...p,
    think: by(p.think, k),
    typing: {
      ...t,
      hold: by(t.hold, k),
      gap: by(t.gap, k),
      beat: by(t.beat, k),
      stallMs: by(t.stallMs, k),
      notice: by(t.notice, k),
      erase: by(t.erase, k),
    },
    mouse: {
      ...m,
      reach: by(m.reach, k),
      perBit: by(m.perBit, k),
      hover: by(m.hover, k),
      hold: by(m.hold, k),
      wanderRest: by(m.wanderRest, k),
      hesitateMs: by(m.hesitateMs, k),
      jitterGap: by(m.jitterGap, k),
    },
    scroll: { ...s, gap: by(s.gap, k), look: by(s.look, k) },
  };
}

/** Twice the calm pace (William 10-28: "I move really fast"). */
const brisker = brisk(CALM_PACE, 2);
/** Key holds stay a fast typist's (60–90 ms); halved they read as a machine. */
export const HUMAN_PACE: Pace = { ...brisker, typing: { ...brisker.typing, hold: [65, 95] } };

/**
 * For a film: the pace of a demo. No slips, no stalls, no wander while
 * reading; keys at a steady clip, a calm reach a viewer can follow.
 */
export const FILM_PACE: Pace = {
  think: [450, 900],
  drift: 0,
  typing: {
    ...CALM_PACE.typing,
    hold: [40, 70],
    gap: [50, 85],
    tempo: [0.9, 1.1],
    wordBeat: 0.08,
    beat: [120, 260],
    stall: 0,
    pasteOver: 600,
    typo: 0,
  },
  mouse: {
    ...CALM_PACE.mouse,
    reach: [260, 360],
    perBit: [110, 150],
    overshoot: 0,
    hover: [180, 280],
    hold: [70, 110],
    tremor: 0.3,
    hesitate: 0,
    jitter: 0.2,
  },
  scroll: { ...CALM_PACE.scroll, look: [500, 900] },
};

/** What a hand did, when (epoch ms): page px, as the page's own events say them. */
export type HandEvent =
  | { kind: "move" | "down" | "up"; t: number; x: number; y: number }
  | { kind: "key"; t: number; key: string }
  | { kind: "scroll"; t: number; dy: number }
  /** The control a click or a type acts on. */
  | { kind: "focus"; t: number; box: { x: number; y: number; w: number; h: number } };

export type HandsLog = (page: Page, e: HandEvent) => void;

const unlogged: HandsLog = () => {};
/** What the hands log shows for a key of a secret. */
const HIDDEN_KEY = "•";

export interface ActTimeout {
  timeout: number;
}

/** A control, or a whole page — meaning whatever has focus there. */
export type KeyTarget = Locator | Page;

const isPage = (t: KeyTarget): t is Page => "keyboard" in t;

export interface Hands {
  /** Read the page before acting. */
  think(page: Page): Promise<void>;
  /** `at`: a point inside the control (a canvas, a captcha picture), from its top-left. */
  click(target: Locator, o: ActTimeout & { at?: Point }): Promise<void>;
  /** A control: replace what it holds with `text`. A page: type at the caret. */
  type(target: KeyTarget, text: string, o: ActTimeout): Promise<void>;
  press(target: KeyTarget, key: string, o: ActTimeout): Promise<void>;
  /** A control: replace what it holds with `text` in one go, as autofill does. A dropdown: choose the option. */
  paste(target: Locator, text: string, o: ActTimeout): Promise<void>;
  /** Press at `from`, carry to `to`, let go: points inside the control from its top-left (a slider, a captcha piece). */
  drag(target: Locator, from: Point, to: Point, o: ActTimeout): Promise<void>;
  /** Move the page down by about `dy` px (up when negative): a feed read, flick by flick. */
  scroll(page: Page, dy: number): Promise<void>;
}

/** A control's box on the page, or a clear error: a drag needs real coordinates. */
async function boxOf(target: Locator, o: ActTimeout) {
  await target.scrollIntoViewIfNeeded(o).catch(() => undefined);
  const box = await target.boundingBox(o);
  if (!box) throw new Error("drag: the control has no box on screen");
  return box;
}

/** Plain Playwright: no pauses, no pointer path. */
export const instantHands: Hands = {
  think: async () => {},
  click: async (target, { at, ...o }) =>
    (at ? target : await pressable(target, o)).click({ ...o, ...(at ? { position: at } : {}) }),
  type: (target, text, o) => (isPage(target) ? target.keyboard.type(text) : target.fill(text, o)),
  press: (target, key, o) => (isPage(target) ? target.keyboard.press(key) : target.press(key, o)),
  paste: async (target, text, o) => {
    if (!(await chosen(target, text, o, (l) => l.click(o)))) await target.fill(text, o);
  },
  async drag(target, from, to, o) {
    const { mouse } = target.page();
    const box = await boxOf(target, o);
    await mouse.move(box.x + from.x, box.y + from.y);
    await mouse.down();
    await mouse.move(box.x + to.x, box.y + to.y, { steps: 12 });
    await mouse.up();
  },
  scroll: (page, dy) => page.mouse.wheel(0, dy),
};

/** Where each page's pointer is: Playwright's mouse has no getter. Dies with the page. */
const pointers = new WeakMap<Page, Point>();

/** The page's size: the emulated viewport, or a real window's (headed Chrome is not emulated). */
async function viewOf(page: Page): Promise<{ width: number; height: number } | null> {
  return (
    page.viewportSize() ??
    (await page
      .evaluate<{ width: number; height: number }>("({ width: innerWidth, height: innerHeight })")
      .catch(() => null))
  );
}

async function pointerOf(page: Page, random: Random): Promise<Point> {
  const known = pointers.get(page);
  if (known) return known;
  // A fresh page: the hand is somewhere over it, not at the corner.
  const view = (await viewOf(page)) ?? { width: 1280, height: 800 };
  const start = { x: view.width * (0.3 + random() * 0.4), y: view.height * (0.3 + random() * 0.4) };
  pointers.set(page, start);
  return start;
}

/** A dot that follows the pointer; for watching a headed run. Once per page, again after each load. */
const shown = new WeakSet<Page>();
const POINTER_DOT = `(() => {
  if (window.__handsDot) return;
  const put = () => {
    const d = document.createElement("div");
    d.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:rgba(232,135,90,.85);box-shadow:0 0 0 2px #fff;left:-20px;top:-20px";
    document.documentElement.appendChild(d);
    addEventListener("mousemove", (e) => { d.style.left = e.clientX + "px"; d.style.top = e.clientY + "px"; }, true);
    window.__handsDot = d;
  };
  document.documentElement ? put() : addEventListener("DOMContentLoaded", put);
})()`;
async function showOn(page: Page) {
  if (shown.has(page)) return;
  shown.add(page);
  await page.addInitScript(POINTER_DOT).catch(() => undefined);
  await page.evaluate(POINTER_DOT).catch(() => undefined);
}

async function play(
  page: Page,
  steps: { x: number; y: number; after: number }[],
  pace: Pace,
  log: HandsLog,
) {
  if (pace.showPointer) await showOn(page);
  for (const step of steps) {
    await page.mouse.move(step.x, step.y);
    pointers.set(page, { x: step.x, y: step.y });
    log(page, { kind: "move", t: Date.now(), x: step.x, y: step.y });
    if (step.after) await page.waitForTimeout(step.after);
  }
}

/** Rest the hand on the mouse where it is, for a draw from `range`. */
async function rest(
  page: Page,
  range: [number, number],
  pace: Pace,
  random: Random,
  log: HandsLog,
) {
  const at = await pointerOf(page, random);
  await play(page, restAt(at, drawMs(range, random), pace.mouse, random), pace, log);
}

async function glide(
  page: Page,
  to: Point,
  size: number,
  pace: Pace,
  random: Random,
  log: HandsLog,
) {
  const path = mousePath(await pointerOf(page, random), to, size, pace.mouse, random);
  await play(page, path, pace, log);
  pointers.set(page, to);
}

/** The wheel, flick by flick, from where the pointer rests. */
async function wheel(page: Page, dy: number, pace: Pace, random: Random, log: HandsLog) {
  if (pace.showPointer) await showOn(page);
  const at = await pointerOf(page, random);
  await page.mouse.move(at.x, at.y);
  for (const step of wheelPlan(dy, pace.scroll, random)) {
    await page.mouse.wheel(0, step.dy);
    log(page, { kind: "scroll", t: Date.now(), dy: step.dy });
    await page.waitForTimeout(step.after);
  }
}

/**
 * Wheel a control into view, as a hand would, when it is off screen: the
 * pointer over the page, a few flicks toward it until it sits in the
 * middle band. Too far, or a box that will not settle: the caller's plain
 * scroll finishes it.
 */
async function wheelTo(target: Locator, o: ActTimeout, pace: Pace, random: Random, log: HandsLog) {
  const page = target.page();
  const view = await viewOf(page);
  const box = await target.boundingBox(o).catch(() => null);
  if (!view || !box) return;
  const inView = box.y >= 0 && box.y + box.height <= view.height;
  if (inView) return;
  // Aim it somewhere between a third and a half of the way down.
  const dy = box.y - view.height * (0.33 + random() * 0.17);
  if (Math.abs(dy) > pace.scroll.most) return;
  await wheel(page, dy, pace, random, log);
}

export function handsFor(
  pace: Pace | null,
  random: Random = Math.random,
  log: HandsLog = unlogged,
  hidden: (text: string) => boolean = () => false,
): Hands {
  if (!pace) return instantHands;
  const key = (page: Page, k: string) => log(page, { kind: "key", t: Date.now(), key: k });

  /**
   * A point a person could press: one the control itself shows, not a badge over it (the
   * "Search by Algolia" logo inside a search box). A few draws, then the middle, then the first.
   */
  const openAim = async (target: Locator, box: Box): Promise<Point> => {
    const first = aimPoint(box, random);
    const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const tries = [first, ...Array.from({ length: 7 }, () => aimPoint(box, random)), middle];
    for (const p of tries) if (await hits(target, box, p)) return p;
    return first;
  };

  const click = async (asked: Locator, { at, ...o }: ActTimeout & { at?: Point }) => {
    const target = at ? asked : await pressable(asked, o);
    const page = target.page();
    await wheelTo(target, o, pace, random, log).catch(() => undefined);
    const box = await target
      .scrollIntoViewIfNeeded(o)
      .then(() => target.boundingBox(o))
      .catch(() => null);
    if (!box) return target.click({ ...o, ...(at ? { position: at } : {}) });
    const aim = at ? { x: box.x + at.x, y: box.y + at.y } : await openAim(target, box);
    await glide(page, aim, Math.min(box.width, box.height), pace, random, log).catch(
      () => undefined,
    );
    await rest(page, pace.mouse.hover, pace, random, log).catch(() => undefined);
    const { x, y, width: w, height: h } = box;
    log(page, { kind: "focus", t: Date.now(), box: { x, y, w, h } });
    // Playwright's click at that spot: it checks the control is still there and uncovered,
    // finds the pointer already on it, and holds the button for `delay`.
    const delay = drawMs(pace.mouse.hold, random);
    await target.click({ ...o, position: { x: aim.x - box.x, y: aim.y - box.y }, delay });
    // The button came up as the click returned, `delay` after it went down.
    const up = Date.now();
    log(page, { kind: "down", t: up - delay, ...aim });
    log(page, { kind: "up", t: up, ...aim });
  };

  return {
    async think(page) {
      const ms = drawMs(pace.think, random);
      const view = chance(pace.drift, random) ? await viewOf(page) : null;
      if (view) {
        const start = Date.now();
        // The wander fits the pause: it ends where the reading does.
        let spent = 0;
        const path = wanderPath(await pointerOf(page, random), view, pace.mouse, random).filter(
          (step) => {
            spent += step.after;
            return spent <= ms;
          },
        );
        await play(page, path, pace, log).catch(() => undefined);
        const left = ms - (Date.now() - start);
        if (left > 0) await page.waitForTimeout(left);
        return;
      }
      await page.waitForTimeout(ms);
    },
    click,
    async drag(target, from, to, o) {
      const page = target.page();
      const box = await boxOf(target, o);
      const size = Math.min(box.width, box.height);
      const start = { x: box.x + from.x, y: box.y + from.y };
      const end = { x: box.x + to.x, y: box.y + to.y };
      await glide(page, start, size, pace, random, log);
      await rest(page, pace.mouse.hover, pace, random, log);
      await page.mouse.down();
      log(page, { kind: "down", t: Date.now(), ...start });
      await rest(page, pace.mouse.hold, pace, random, log);
      await glide(page, end, size, pace, random, log);
      await rest(page, pace.mouse.hover, pace, random, log);
      await page.mouse.up();
      log(page, { kind: "up", t: Date.now(), ...end });
    },
    scroll: (page, dy) => wheel(page, dy, pace, random, log),
    async type(target, text, o) {
      const page = isPage(target) ? target : target.page();
      if (!isPage(target)) {
        await click(target, o);
        // A click on a wrapper or an overlay leaves focus elsewhere and the keys would
        // go nowhere: put focus on the control, as a person's second click would.
        if (!(await hasFocus(target))) await target.focus(o);
        await target.fill("", o);
      }
      if ([...text].length > pace.typing.pasteOver) {
        await page.waitForTimeout(drawMs(pace.think, random));
        return isPage(target) ? target.keyboard.insertText(text) : target.fill(text, o);
      }
      // The click focused the control: keys go to the page's keyboard from here, not
      // through the locator, which re-checks and re-focuses the control on every key.
      const hide = hidden(text);
      for (const k of typingPlan(text, pace.typing, random)) {
        key(page, hide && k.ch !== BACKSPACE ? HIDDEN_KEY : k.ch);
        // `delay` is how long the key is held: down, wait, up.
        if (k.ch === BACKSPACE) await page.keyboard.press(BACKSPACE, { delay: k.hold });
        else await page.keyboard.type(k.ch, { delay: k.hold });
        if (k.after) await page.waitForTimeout(k.after);
      }
      // Keys that landed nowhere leave the field empty: a person would see it and fill it.
      if (!isPage(target) && text && (await fieldValue(target)) === "") await target.fill(text, o);
    },
    async paste(target, text, o) {
      if (await chosen(target, text, o, (l) => click(l, o))) return;
      await click(target, o);
      await rest(target.page(), pace.mouse.hover, pace, random, log).catch(() => undefined);
      // A code split one box per character (Microsoft's six digit boxes): a fill lands
      // it all in the first box. Keys, as a person types them, move the widget along.
      if ([...text].length > 1 && (await boxWidth(target)) === 1) {
        await target.fill("", o);
        const hide = hidden(text);
        for (const ch of text) {
          key(target.page(), hide ? HIDDEN_KEY : ch);
          await target.page().keyboard.type(ch, { delay: drawMs(pace.typing.hold, random) });
        }
        return;
      }
      await target.fill(text, o);
    },
    press: (target, k, o) => {
      const delay = drawMs(pace.typing.hold, random);
      key(isPage(target) ? target : target.page(), k);
      return isPage(target)
        ? target.keyboard.press(k, { delay })
        : target.press(k, { ...o, delay });
    },
  };
}

/**
 * Whether a press at `p` (page px, as `box` is) lands on the control or inside it. In the
 * control's own frame: the box and its client rect differ by the frame's offset.
 */
const hits = (target: Locator, box: Box, p: Point): Promise<boolean> =>
  target
    .evaluate(
      (el, { box, p }) => {
        const r = el.getBoundingClientRect();
        const hit = el.ownerDocument.elementFromPoint(p.x - box.x + r.x, p.y - box.y + r.y);
        return !!hit && (hit === el || el.contains(hit));
      },
      { box: { x: box.x, y: box.y }, p },
    )
    .catch(() => true);

/** Whether the control (or something inside it) has focus; unknown counts as yes. */
const hasFocus = (target: Locator): Promise<boolean> =>
  target
    .evaluate(
      (el) => el === el.ownerDocument.activeElement || el.contains(el.ownerDocument.activeElement),
    )
    .catch(() => true);

/**
 * How many characters the field holds: its maxlength, else 1 for a box in a row of
 * code boxes (`codeEntry-0`, `otp-1`, "digit 1"); null when it is an ordinary field.
 */
/** A dropdown: a native select, or a control that opens a list. Null: a field that takes keys. */
async function dropdownKind(target: Locator, o: ActTimeout): Promise<"select" | "list" | null> {
  return target
    .evaluate(
      (el) => {
        if (el.tagName === "SELECT") return "select";
        // A label fills its field (Playwright retargets); fields and editors take keys.
        if (/^(INPUT|TEXTAREA|LABEL)$/.test(el.tagName)) return null;
        if (el.getAttribute("role") === "combobox") return "list";
        const takesKeys =
          (el as { isContentEditable?: boolean }).isContentEditable ||
          el.querySelector("input, textarea, select, [contenteditable]");
        return takesKeys ? null : "list";
      },
      undefined,
      o,
    )
    .catch(() => null);
}

/**
 * The control a hand can press: the target, or, when it has no size (Discord's
 * date pickers put role=combobox on a 0x0 div), its nearest ancestor that has one.
 */
export async function pressable(target: Locator, o: ActTimeout): Promise<Locator> {
  const up = await target
    .evaluate(
      // No named helpers inside: tsx wraps them in `__name`, which the page does not have.
      (el) => {
        let n = 0;
        for (let e: typeof el | null = el; e && n <= 6; e = e.parentElement, n++) {
          const r = e.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return n;
        }
        return 0;
      },
      undefined,
      o,
    )
    // Not there in time: that is the act's own error, not a second wait.
    .catch((err: unknown) => {
      if (/Timeout/.test(String(err))) throw err;
      return 0;
    });
  return up ? target.locator(`xpath=ancestor::*[${up}]`) : target;
}

/** The open list's option by its whole name, by role. */
const optionNamed = (page: Page, text: string): Locator =>
  page
    .getByRole("option", { name: text, exact: true })
    .or(page.getByRole("menuitem", { name: text, exact: true }))
    .or(page.getByRole("menuitemradio", { name: text, exact: true }))
    .locator("visible=true")
    .first();

const seen = (l: Locator, timeout: number): Promise<boolean> =>
  l
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);

/**
 * A long list renders only the rows in view (Discord's years): wheel over it,
 * down then back up, until the option shows or the list stops moving.
 */
async function wheelToOption(page: Page, option: Locator): Promise<boolean> {
  const list = page.getByRole("listbox").locator("visible=true").first();
  const box = await list.boundingBox({ timeout: 1_000 }).catch(() => null);
  if (!box) return false;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const rows = () => list.innerText({ timeout: 1_000 }).catch(() => "");
  for (const dy of [box.height * 0.8, -box.height * 0.8]) {
    let last = await rows();
    for (let step = 0, still = 0; step < 60 && still < 2; step++) {
      await page.mouse.wheel(0, dy);
      if (await seen(option, 150)) return true;
      const now = await rows();
      still = now === last ? still + 1 : 0;
      last = now;
    }
  }
  return false;
}

/**
 * Choose `text` from a dropdown: a native select by value, any other by
 * opening it and pressing the option. The option by role, else scrolled into
 * a long list, else the first visible element whose whole text is it (a list
 * of plain divs: Azure's card expiry, Dynadot).
 */
export async function pickOption(
  target: Locator,
  text: string,
  o: ActTimeout,
  tap: (l: Locator) => Promise<void>,
  kind: "select" | "list" | null = null,
): Promise<void> {
  if ((kind ?? (await dropdownKind(target, o))) === "select") {
    await target.selectOption(text, o);
    return;
  }
  await tap(await pressable(target, o));
  const page = target.page();
  const option = optionNamed(page, text);
  if ((await seen(option, 2_000)) || (await wheelToOption(page, option))) return tap(option);
  await tap(page.getByText(text, { exact: true }).locator("visible=true").first());
}

/** A dropdown takes a value by its option, not by keys. True when it was one. */
async function chosen(
  target: Locator,
  text: string,
  o: ActTimeout,
  tap: (l: Locator) => Promise<void>,
): Promise<boolean> {
  const kind = await dropdownKind(target, o);
  if (kind) await pickOption(target, text, o, tap, kind);
  return kind !== null;
}

const boxWidth = (target: Locator): Promise<number | null> =>
  target
    .evaluate((el) => {
      const input = el as typeof el & { maxLength?: number; name?: string };
      if (input.maxLength && input.maxLength > 0) return input.maxLength;
      const label = `${input.id} ${input.name ?? ""} ${input.getAttribute("aria-label") ?? ""}`;
      const siblings = input.parentElement?.parentElement?.querySelectorAll("input").length ?? 0;
      return siblings >= 4 && /code|otp|digit|pin/i.test(label) ? 1 : null;
    })
    .catch(() => null);

/** A field's value; null for anything that is not a field (a rich editor keeps its own). */
const fieldValue = (target: Locator): Promise<string | null> =>
  target.inputValue({ timeout: 1_000 }).catch(() => null);
