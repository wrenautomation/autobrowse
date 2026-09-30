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
 * `showPointer` draws the pointer on the page (a dot), to watch a headed run;
 * it puts an element in the page, so it is for watching, never for real runs.
 *
 * This folder imports nothing from autobrowse: only Playwright's types.
 */
import type { Locator, Page } from "playwright";
import { chance, drawMs, type Random } from "./draw.js";
import { aimPoint, type MouseStyle, mousePath, type Point, restAt, wanderPath } from "./mouse.js";
import { type ScrollStyle, wheelPlan } from "./scroll.js";
import { BACKSPACE, type TypingStyle, typingPlan } from "./typing.js";

export { drawMs } from "./draw.js";
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

export const HUMAN_PACE: Pace = {
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
  /** A control: replace what it holds with `text` in one go, as autofill does. */
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
  click: (target, { at, ...o }) => target.click({ ...o, ...(at ? { position: at } : {}) }),
  type: (target, text, o) => (isPage(target) ? target.keyboard.type(text) : target.fill(text, o)),
  press: (target, key, o) => (isPage(target) ? target.keyboard.press(key) : target.press(key, o)),
  paste: (target, text, o) => target.fill(text, o),
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

async function play(page: Page, steps: { x: number; y: number; after: number }[], pace: Pace) {
  if (pace.showPointer) await showOn(page);
  for (const step of steps) {
    await page.mouse.move(step.x, step.y);
    pointers.set(page, { x: step.x, y: step.y });
    if (step.after) await page.waitForTimeout(step.after);
  }
}

/** Rest the hand on the mouse where it is, for a draw from `range`. */
async function rest(page: Page, range: [number, number], pace: Pace, random: Random) {
  const at = await pointerOf(page, random);
  await play(page, restAt(at, drawMs(range, random), pace.mouse, random), pace);
}

async function glide(page: Page, to: Point, size: number, pace: Pace, random: Random) {
  await play(page, mousePath(await pointerOf(page, random), to, size, pace.mouse, random), pace);
  pointers.set(page, to);
}

/**
 * Wheel a control into view, as a hand would, when it is off screen: the
 * pointer over the page, a few flicks toward it until it sits in the
 * middle band. Too far, or a box that will not settle: the caller's plain
 * scroll finishes it.
 */
async function wheelTo(target: Locator, o: ActTimeout, pace: Pace, random: Random) {
  const page = target.page();
  const view = await viewOf(page);
  const box = await target.boundingBox(o).catch(() => null);
  if (!view || !box) return;
  const inView = box.y >= 0 && box.y + box.height <= view.height;
  if (inView) return;
  // Aim it somewhere between a third and a half of the way down.
  const dy = box.y - view.height * (0.33 + random() * 0.17);
  if (Math.abs(dy) > pace.scroll.most) return;
  if (pace.showPointer) await showOn(page);
  const at = await pointerOf(page, random);
  await page.mouse.move(at.x, at.y);
  for (const step of wheelPlan(dy, pace.scroll, random)) {
    await page.mouse.wheel(0, step.dy);
    await page.waitForTimeout(step.after);
  }
}

export function handsFor(pace: Pace | null, random: Random = Math.random): Hands {
  if (!pace) return instantHands;

  const click = async (target: Locator, { at, ...o }: ActTimeout & { at?: Point }) => {
    const page = target.page();
    await wheelTo(target, o, pace, random).catch(() => undefined);
    const box = await target
      .scrollIntoViewIfNeeded(o)
      .then(() => target.boundingBox(o))
      .catch(() => null);
    if (!box) return target.click({ ...o, ...(at ? { position: at } : {}) });
    const aim = at ? { x: box.x + at.x, y: box.y + at.y } : aimPoint(box, random);
    await glide(page, aim, Math.min(box.width, box.height), pace, random).catch(() => undefined);
    await rest(page, pace.mouse.hover, pace, random).catch(() => undefined);
    // Playwright's click at that spot: it checks the control is still there and uncovered,
    // finds the pointer already on it, and holds the button for `delay`.
    await target.click({
      ...o,
      position: { x: aim.x - box.x, y: aim.y - box.y },
      delay: drawMs(pace.mouse.hold, random),
    });
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
        await play(page, path, pace).catch(() => undefined);
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
      await glide(page, start, size, pace, random);
      await rest(page, pace.mouse.hover, pace, random);
      await page.mouse.down();
      await rest(page, pace.mouse.hold, pace, random);
      await glide(page, end, size, pace, random);
      await rest(page, pace.mouse.hover, pace, random);
      await page.mouse.up();
    },
    async scroll(page, dy) {
      if (pace.showPointer) await showOn(page);
      const at = await pointerOf(page, random);
      await page.mouse.move(at.x, at.y);
      for (const step of wheelPlan(dy, pace.scroll, random)) {
        await page.mouse.wheel(0, step.dy);
        await page.waitForTimeout(step.after);
      }
    },
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
      for (const k of typingPlan(text, pace.typing, random)) {
        // `delay` is how long the key is held: down, wait, up.
        if (k.ch === BACKSPACE) await page.keyboard.press(BACKSPACE, { delay: k.hold });
        else await page.keyboard.type(k.ch, { delay: k.hold });
        if (k.after) await page.waitForTimeout(k.after);
      }
      // Keys that landed nowhere leave the field empty: a person would see it and fill it.
      if (!isPage(target) && text && (await fieldValue(target)) === "") await target.fill(text, o);
    },
    async paste(target, text, o) {
      await click(target, o);
      await rest(target.page(), pace.mouse.hover, pace, random).catch(() => undefined);
      // A code split one box per character (Microsoft's six digit boxes): a fill lands
      // it all in the first box. Keys, as a person types them, move the widget along.
      if ([...text].length > 1 && (await boxWidth(target)) === 1) {
        await target.fill("", o);
        for (const ch of text)
          await target.page().keyboard.type(ch, { delay: drawMs(pace.typing.hold, random) });
        return;
      }
      await target.fill(text, o);
    },
    press: (target, key, o) => {
      const delay = drawMs(pace.typing.hold, random);
      return isPage(target)
        ? target.keyboard.press(key, { delay })
        : target.press(key, { ...o, delay });
    },
  };
}

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
