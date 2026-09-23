/**
 * Human hands: the one door every browser act goes through.
 *
 * A flow, a compiled workflow, the explore console and the agent all say
 * the same four things — think, click, type, press — and `Hands` decides
 * how a person would do them. Sites watch for the other kind: instant
 * clicks on the exact centre, a pointer that teleports, every key 50ms
 * apart. So:
 *
 *   think  a pause to read the page; sometimes the hand drifts meanwhile
 *   click  a curved, eased reach to a spot near the middle of the control,
 *          a beat of hover, the button held down a moment
 *   type   runs of fast and slow keys, beats between words and after
 *          punctuation, the odd stall mid-word; long text is pasted
 *   press  one key, held down like a key is
 *   paste  a value that arrives whole, as autofill or a password manager
 *          puts it: the field clicked, a beat, the text in at once
 *
 * The details live beside this file (typing.ts, mouse.ts, draw.ts) as
 * pure plans with no page in them; this file only plays them. Every click
 * still ends in Playwright's own click at the chosen spot, so its checks
 * (visible, enabled, not covered, inside an iframe) stand; any trouble in
 * the human part falls back to the plain act, never to a failure.
 *
 * `handsFor(null)` is instant hands: demos, tests, a console answering at once.
 */
import type { Locator, Page } from "playwright";
import { chance, drawMs, type Random } from "./draw.js";
import { aimPoint, driftPoint, type MouseStyle, mousePath, type Point } from "./mouse.js";
import { type TypingStyle, typingPlan } from "./typing.js";

export { drawMs } from "./draw.js";
export type { MouseStyle, PathStep } from "./mouse.js";
export { aimPoint, mousePath } from "./mouse.js";
export type { Keystroke, TypingStyle } from "./typing.js";
export { typingPlan } from "./typing.js";

export interface Pace {
  /** Reading the page before an act, ms. */
  think: [number, number];
  /** Chance the hand drifts while thinking. */
  drift: number;
  typing: TypingStyle;
  mouse: MouseStyle;
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
  },
  mouse: {
    reach: [90, 170],
    perBit: [80, 140],
    overshoot: 0.2,
    overshootBy: [0.03, 0.09],
    hover: [70, 260],
    hold: [45, 130],
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
  click(target: Locator, o: ActTimeout): Promise<void>;
  /** A control: replace what it holds with `text`. A page: type at the caret. */
  type(target: KeyTarget, text: string, o: ActTimeout): Promise<void>;
  press(target: KeyTarget, key: string, o: ActTimeout): Promise<void>;
  /** A control: replace what it holds with `text` in one go, as autofill does. */
  paste(target: Locator, text: string, o: ActTimeout): Promise<void>;
}

/** Plain Playwright: no pauses, no pointer path. */
export const instantHands: Hands = {
  think: async () => {},
  click: (target, o) => target.click(o),
  type: (target, text, o) => (isPage(target) ? target.keyboard.type(text) : target.fill(text, o)),
  press: (target, key, o) => (isPage(target) ? target.keyboard.press(key) : target.press(key, o)),
  paste: (target, text, o) => target.fill(text, o),
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

async function glide(page: Page, to: Point, size: number, pace: Pace, random: Random) {
  for (const step of mousePath(await pointerOf(page, random), to, size, pace.mouse, random)) {
    await page.mouse.move(step.x, step.y);
    if (step.after) await page.waitForTimeout(step.after);
  }
  pointers.set(page, to);
}

export function handsFor(pace: Pace | null, random: Random = Math.random): Hands {
  if (!pace) return instantHands;

  const click = async (target: Locator, o: ActTimeout) => {
    const page = target.page();
    const box = await target
      .scrollIntoViewIfNeeded(o)
      .then(() => target.boundingBox(o))
      .catch(() => null);
    if (!box) return target.click(o);
    const aim = aimPoint(box, random);
    await glide(page, aim, Math.min(box.width, box.height), pace, random).catch(() => undefined);
    await page.waitForTimeout(drawMs(pace.mouse.hover, random));
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
        const to = driftPoint(await pointerOf(page, random), view, random);
        await glide(page, to, 40, pace, random).catch(() => undefined);
        const left = ms - (Date.now() - start);
        if (left > 0) await page.waitForTimeout(left);
        return;
      }
      await page.waitForTimeout(ms);
    },
    click,
    async type(target, text, o) {
      const page = isPage(target) ? target : target.page();
      if (!isPage(target)) {
        await click(target, o);
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
        await page.keyboard.type(k.ch, { delay: k.hold });
        if (k.after) await page.waitForTimeout(k.after);
      }
    },
    async paste(target, text, o) {
      await click(target, o);
      await target.page().waitForTimeout(drawMs(pace.mouse.hover, random));
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
