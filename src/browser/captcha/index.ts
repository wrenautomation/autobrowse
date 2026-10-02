/**
 * Captchas: find one on the page and solve it the way a person would, with
 * the same hands (`browser/human`) every other act uses.
 *
 *   checkbox  "I'm not a robot" (reCAPTCHA, hCaptcha, Cloudflare Turnstile):
 *             one human click, then wait for the tick
 *   grid      "select all squares with traffic lights": the challenge is
 *             photographed, the eyes name the squares, the hands click them
 *             and press Verify; new squares fading in are looked at again.
 *             hCaptcha's canvas tasks ("click the…", "drag the animal into
 *             its outline") have no squares: the eyes give points to click
 *             or a drag, or say skip for a fresh task
 *   text      a picture of letters beside a box: the eyes read, the hands type
 *   slider    a puzzle piece to drag into its gap: the eyes say how far
 *   hold      "press and hold" (HUMAN, on Microsoft's signup): the button is
 *             held down until the challenge lets go
 *
 * The eyes are any model that can see (`Eyes`): the picture is the captcha
 * box alone, cut from the page in memory, never written to disk. Without
 * eyes only the checkbox kind is solved; the rest is a person's.
 *
 * This folder imports nothing from autobrowse but the hands: Playwright's
 * types and `../human`.
 */
import type { FrameLocator, Locator, Page } from "playwright";
import type { Hands } from "../human/index.js";

export type CaptchaKind = "checkbox" | "grid" | "text" | "slider" | "hold";
export type CaptchaVendor = "recaptcha" | "hcaptcha" | "turnstile" | "human" | "generic";

export interface Captcha {
  kind: CaptchaKind;
  vendor: CaptchaVendor;
}

/** A model that can see: a PNG and a question in, its answer (JSON text) out. */
export interface Eyes {
  look(png: Buffer, question: string): Promise<string>;
}

export type CaptchaOutcome =
  | { solved: true; kind: CaptchaKind; vendor: CaptchaVendor; rounds: number }
  | { solved: false; kind: CaptchaKind | null; vendor: CaptchaVendor | null; reason: string };

export interface SolveOptions {
  hands: Hands;
  /** Absent: checkboxes only. */
  eyes?: Eyes | null;
  /** Challenge rounds before handing it to a person. Default 6. */
  rounds?: number;
  /** How long a tick or a new challenge takes to show. Default 8s. */
  settleMs?: number;
}

const T = { timeout: 10_000 };

/** Where each vendor keeps its parts. */
const RECAPTCHA = {
  anchor: 'iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]',
  bframe: 'iframe[src*="recaptcha/api2/bframe"], iframe[src*="recaptcha/enterprise/bframe"]',
  box: "#recaptcha-anchor",
  ticked: '#recaptcha-anchor[aria-checked="true"]',
  challenge: "#rc-imageselect, .rc-imageselect-challenge",
  tiles: "td.rc-imageselect-tile",
  verify: "#recaptcha-verify-button",
  prompt: ".rc-imageselect-instructions, .rc-imageselect-desc-wrapper",
};
const HCAPTCHA = {
  anchor: 'iframe[src*="hcaptcha.com"][src*="frame=checkbox"]',
  bframe: 'iframe[src*="hcaptcha.com"][src*="frame=challenge"]',
  box: "#checkbox",
  ticked: '#checkbox[aria-checked="true"]',
  challenge: ".challenge-container, .challenge",
  tiles: ".task-image, .task",
  verify: ".button-submit",
  prompt: ".prompt-text, h2",
};
const TURNSTILE = {
  frame: 'iframe[src*="challenges.cloudflare.com"]',
  box: 'input[type="checkbox"], label',
  response: 'input[name="cf-turnstile-response"]',
};
const GENERIC = {
  picture:
    'img[src*="captcha" i], img[alt*="captcha" i], img[id*="captcha" i], img[class*="captcha" i]',
  input:
    'input[name*="captcha" i], input[id*="captcha" i], input[placeholder*="characters" i], input[aria-label*="captcha" i]',
  slider:
    '.secsdk-captcha-drag-icon, [class*="captcha" i] [class*="slider" i] [class*="btn" i], [class*="captcha" i] [class*="drag" i], [id*="captcha" i] [class*="slider" i]',
  puzzle:
    '[class*="captcha" i][class*="container" i], [class*="captcha" i][class*="verify" i], [id*="captcha" i]',
};

/** HUMAN's press-and-hold button, by its label or its words (its frames nest two deep). */
const HOLD =
  '[aria-label*="press & hold" i], [aria-label*="press and hold" i], [role="button"]:has-text("Press & Hold"), button:has-text("Press & Hold")';

const holdButton = (page: Page): Promise<Locator | null> => shown(page, HOLD);

/**
 * Cloudflare's own challenge page puts Turnstile in a closed shadow root:
 * no selector reaches it, but the frame list does. Its box on the page,
 * when one is showing.
 */
async function turnstileBox(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  for (const f of page.frames()) {
    if (!f.url().includes("challenges.cloudflare.com")) continue;
    const box = await f
      .frameElement()
      .then((e) => e.boundingBox())
      .catch(() => null);
    if (box && box.width > 0 && box.height > 0) return box;
  }
  return null;
}

const turnstileShown = async (page: Page): Promise<boolean> =>
  (await shown(page, TURNSTILE.frame)) !== null || (await turnstileBox(page)) !== null;

const visible = (l: Locator) =>
  l
    .first()
    .isVisible()
    .catch(() => false);

/**
 * The first visible match in the page or any frame inside it: widgets nest
 * (Facebook's checkpoint puts reCAPTCHA's iframe inside one of its own), so
 * a page-level selector alone misses them.
 */
async function shown(page: Page, selector: string): Promise<Locator | null> {
  for (const f of page.frames()) {
    const l = f.locator(selector);
    if (await visible(l)) return l.first();
  }
  return null;
}

/** The inside of a vendor's iframe, wherever on the page it sits. */
async function inside(page: Page, iframe: string): Promise<FrameLocator> {
  const el = await shown(page, iframe);
  if (!el) throw new Error("the captcha frame went away");
  return el.contentFrame();
}

/** The captcha on the page, the challenge before its checkbox (an open challenge is what is asked now). */
export async function findCaptcha(page: Page): Promise<Captcha | null> {
  const on = async (selector: string) => (await shown(page, selector)) !== null;
  if (await on(RECAPTCHA.bframe)) return { kind: "grid", vendor: "recaptcha" };
  if (await on(HCAPTCHA.bframe)) return { kind: "grid", vendor: "hcaptcha" };
  if (await on(RECAPTCHA.anchor)) return { kind: "checkbox", vendor: "recaptcha" };
  if (await on(HCAPTCHA.anchor)) return { kind: "checkbox", vendor: "hcaptcha" };
  if (await turnstileShown(page)) return { kind: "checkbox", vendor: "turnstile" };
  if (await holdButton(page)) return { kind: "hold", vendor: "human" };
  if (await on(GENERIC.slider)) return { kind: "slider", vendor: "generic" };
  if ((await on(GENERIC.picture)) && (await on(GENERIC.input)))
    return { kind: "text", vendor: "generic" };
  return null;
}

/** Solve whatever captcha the page shows, a round at a time, until it is gone or the rounds run out. */
export async function solveCaptcha(page: Page, o: SolveOptions): Promise<CaptchaOutcome> {
  const rounds = o.rounds ?? 6;
  const settle = o.settleMs ?? 8_000;
  let last: Captcha | null = null;
  for (let round = 1; round <= rounds; round++) {
    const now = await findCaptcha(page);
    if (!now) {
      if (!last)
        return { solved: false, kind: null, vendor: null, reason: "no captcha on the page" };
      return { solved: true, ...last, rounds: round - 1 };
    }
    last = now;
    if (now.kind !== "checkbox" && now.kind !== "hold" && !o.eyes)
      return {
        solved: false,
        ...now,
        reason: `a ${now.kind} captcha needs eyes (a model that sees)`,
      };
    let done: Step;
    try {
      done =
        now.kind === "checkbox"
          ? await tick(page, now.vendor, o.hands, settle)
          : now.kind === "hold"
            ? await hold(page, o.hands, settle)
            : now.kind === "grid"
              ? await pickSquares(page, now.vendor, o.hands, o.eyes as Eyes, settle)
              : now.kind === "text"
                ? await readLetters(page, o.hands, o.eyes as Eyes)
                : await slide(page, o.hands, o.eyes as Eyes, settle);
    } catch (err) {
      // A model that cannot see, a part that moved: the person's, with the reason.
      const why = err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
      return { solved: false, ...now, reason: why.slice(0, 160) };
    }
    if (done === "gave-up")
      return { solved: false, ...now, reason: `the eyes could not read the ${now.kind}` };
    if (done === "ticked") return { solved: true, ...now, rounds: round };
    await page.waitForTimeout(1_000);
  }
  return {
    solved: false,
    kind: last?.kind ?? null,
    vendor: last?.vendor ?? null,
    reason: `still there after ${rounds} rounds`,
  };
}

type Step = "ticked" | "again" | "gave-up";

/** One human click on the box; ticked, or a challenge opened (the next round takes it). */
async function tick(
  page: Page,
  vendor: CaptchaVendor,
  hands: Hands,
  settleMs: number,
): Promise<Step> {
  if (vendor === "turnstile") {
    if (await shown(page, TURNSTILE.frame)) {
      const frame = await inside(page, TURNSTILE.frame);
      await hands.click(frame.locator(TURNSTILE.box).first(), T).catch(() => undefined);
    } else {
      // Shadow-rooted: the box sits at the widget's left edge, half way down.
      const box = await turnstileBox(page);
      const body = page.locator("body");
      const origin = await body.boundingBox().catch(() => null);
      if (box && origin) {
        await hands.think(page);
        const at = {
          x: box.x - origin.x + Math.min(32, box.width * 0.1),
          y: box.y - origin.y + box.height / 2,
        };
        await hands.click(body, { ...T, at }).catch(() => undefined);
      }
    }
    const until = Date.now() + settleMs * 2;
    let goneSince: number | null = null;
    while (Date.now() < until) {
      const token = await page
        .locator(TURNSTILE.response)
        .first()
        .inputValue()
        .catch(() => "");
      if (token) return "ticked";
      // Gone for good, not a reload between tries (Cloudflare's page re-renders it).
      if (await turnstileShown(page)) goneSince = null;
      else {
        goneSince ??= Date.now();
        if (Date.now() - goneSince >= 2_000) return "ticked";
      }
      await page.waitForTimeout(500);
    }
    return "again";
  }
  const parts = vendor === "hcaptcha" ? HCAPTCHA : RECAPTCHA;
  const frame = await inside(page, parts.anchor);
  await hands.think(page);
  await hands.click(frame.locator(parts.box), T);
  const until = Date.now() + settleMs;
  while (Date.now() < until) {
    if (await visible(frame.locator(parts.ticked))) return "ticked";
    if (await shown(page, parts.bframe)) return "again";
    await page.waitForTimeout(400);
  }
  return "again";
}

/** The squares the eyes name, as 1-based numbers left to right, top to bottom. */
export function parseSquares(answer: string, count: number): number[] | null {
  const m = /\{[\s\S]*\}/.exec(answer);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]) as { squares?: unknown };
    if (!Array.isArray(v.squares)) return null;
    return [...new Set(v.squares.map(Number))].filter(
      (n) => Number.isInteger(n) && n >= 1 && n <= count,
    );
  } catch {
    return null;
  }
}

async function pickSquares(
  page: Page,
  vendor: CaptchaVendor,
  hands: Hands,
  eyes: Eyes,
  settleMs: number,
): Promise<Step> {
  const parts = vendor === "hcaptcha" ? HCAPTCHA : RECAPTCHA;
  const frame = await inside(page, parts.bframe);
  // reCAPTCHA fades new squares in where clicked ones were: look again until none is left.
  for (let look = 0; look < 4; look++) {
    const tiles = frame.locator(parts.tiles);
    const count = await tiles.count();
    if (!count && vendor === "hcaptcha") return canvasTask(page, frame, hands, eyes, settleMs);
    if (!count) return "gave-up";
    const ask = (
      await frame
        .locator(parts.prompt)
        .first()
        .innerText(T)
        .catch(() => "")
    )
      .replace(/\s+/g, " ")
      .trim();
    const png = await frame
      .locator(parts.challenge)
      .first()
      .screenshot({ ...T, type: "png" });
    const side = Math.round(Math.sqrt(count));
    const answer = await eyes.look(
      png,
      `A captcha: ${ask || "select the matching squares"}. The picture is a grid of ${count} squares (${side} by ${Math.ceil(count / side)}), numbered 1 to ${count} left to right, top to bottom. Which squares match? Reply {"squares":[numbers]}; [] when none do.`,
    );
    const squares = parseSquares(answer, count);
    if (!squares) return "gave-up";
    for (const n of squares) {
      await hands.click(tiles.nth(n - 1), T);
      await page.waitForTimeout(250);
    }
    const dynamic = /none left|no more|once there are none/i.test(ask);
    if (!dynamic || !squares.length) break;
    await page.waitForTimeout(4_500); // the new squares fade in slowly
  }
  await hands.click(frame.locator(parts.verify).first(), T);
  const until = Date.now() + settleMs;
  while (Date.now() < until) {
    if (!(await shown(page, parts.bframe))) return "ticked";
    await page.waitForTimeout(500);
  }
  // Still open: a wrong pick or a fresh challenge; the next round looks again.
  return "again";
}

/** A canvas task's answer: points to click, one drag, or a fresh task. */
export type CanvasMove =
  | { clicks: { x: number; y: number }[] }
  | { drag: { from: { x: number; y: number }; to: { x: number; y: number } } }
  | { skip: true };

/** The eyes' reply in picture pixels, as CSS points inside a box `scale` times smaller; null when unreadable. */
export function parseCanvasMove(
  answer: string,
  scale: number,
  w: number,
  h: number,
): CanvasMove | null {
  const m = /\{[\s\S]*\}/.exec(answer);
  if (!m) return null;
  const point = (v: unknown) => {
    if (!Array.isArray(v) || v.length !== 2) return null;
    const [x, y] = v.map((n) => Number(n) / scale);
    if (x === undefined || y === undefined) return null;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > w || y > h) return null;
    return { x, y };
  };
  try {
    const v = JSON.parse(m[0]) as {
      clicks?: unknown;
      drag?: { from?: unknown; to?: unknown };
      skip?: unknown;
    };
    if (v.skip === true) return { skip: true };
    if (Array.isArray(v.clicks)) {
      const clicks = v.clicks.map(point);
      if (!clicks.length || clicks.some((c) => c === null)) return null;
      return { clicks: clicks as { x: number; y: number }[] };
    }
    if (v.drag) {
      const from = point(v.drag.from);
      const to = point(v.drag.to);
      return from && to ? { drag: { from, to } } : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** A PNG's width in pixels, from its header. */
const pngWidth = (png: Buffer) => png.readUInt32BE(16);

/**
 * hCaptcha's canvas task: the picture and its question to the eyes, their
 * clicks or drag by the hands, then Next/Verify. Unsure, or an answer that
 * does not parse: Skip (the same button before any move) for a fresh task.
 */
async function canvasTask(
  page: Page,
  frame: FrameLocator,
  hands: Hands,
  eyes: Eyes,
  settleMs: number,
): Promise<Step> {
  const canvas = frame.locator("canvas").first();
  if (!(await visible(canvas))) return "gave-up";
  const box = await canvas.boundingBox(T);
  if (!box) return "gave-up";
  const ask = (
    await frame
      .locator(HCAPTCHA.prompt)
      .first()
      .innerText(T)
      .catch(() => "")
  )
    .replace(/\s+/g, " ")
    .trim();
  const png = await canvas.screenshot({ ...T, type: "png" });
  const scale = pngWidth(png) / box.width || 1;
  const answer = await eyes.look(
    png,
    `A captcha: ${ask || "solve the task in the picture"}. The picture is ${Math.round(box.width * scale)} by ${Math.round(box.height * scale)} pixels, x from the left, y from the top. Reply with pixel points in it: {"clicks":[[x,y],...]} for a task that says click or select; {"drag":{"from":[x,y],"to":[x,y]}} for one that says drag, move or place (from = the middle of the piece, to = the middle of where it goes); {"skip":true} when unsure.`,
  );
  const move = parseCanvasMove(answer, scale, box.width, box.height);
  const submit = frame.locator(HCAPTCHA.verify).first();
  if (!move || "skip" in move) {
    await hands.click(submit, T); // reads "Skip" before any move
    await page.waitForTimeout(2_000);
    return "again";
  }
  if ("clicks" in move)
    for (const at of move.clicks) {
      await hands.click(canvas, { ...T, at });
      await page.waitForTimeout(300);
    }
  else await hands.drag(canvas, move.drag.from, move.drag.to, T);
  await page.waitForTimeout(500);
  await hands.click(submit, T);
  const until = Date.now() + settleMs;
  while (Date.now() < until) {
    if (!(await shown(page, HCAPTCHA.bframe))) return "ticked";
    await page.waitForTimeout(500);
  }
  return "again";
}

async function readLetters(page: Page, hands: Hands, eyes: Eyes): Promise<Step> {
  const picture = await shown(page, GENERIC.picture);
  const input = await shown(page, GENERIC.input);
  if (!picture || !input) return "gave-up";
  const png = await picture.screenshot({ ...T, type: "png" });
  const answer = await eyes.look(
    png,
    'A text captcha: the letters and digits in the picture, exactly as shown (case matters). Reply {"text":"..."}.',
  );
  const text = /"text"\s*:\s*"([^"]{1,20})"/.exec(answer)?.[1]?.trim();
  if (!text) return "gave-up";
  await hands.type(input, text, T);
  // The form's own submit is the flow's to press: a text captcha is one field of it.
  return "ticked";
}

async function slide(page: Page, hands: Hands, eyes: Eyes, settleMs: number): Promise<Step> {
  const handle = await shown(page, GENERIC.slider);
  const puzzle = await shown(page, GENERIC.puzzle);
  if (!handle || !puzzle) return "gave-up";
  const box = await puzzle.boundingBox(T);
  const grip = await handle.boundingBox(T);
  if (!box || !grip) return "gave-up";
  const png = await puzzle.screenshot({ ...T, type: "png" });
  const answer = await eyes.look(
    png,
    `A slider captcha ${Math.round(box.width)} pixels wide: a puzzle piece at the left must be dragged right into its gap. How many pixels right from where the piece is now does it go? Reply {"pixels":n}.`,
  );
  const px = Number(/"pixels"\s*:\s*(-?\d+(?:\.\d+)?)/.exec(answer)?.[1]);
  if (!Number.isFinite(px) || px <= 0 || px > box.width) return "gave-up";
  const from = { x: grip.width / 2, y: grip.height / 2 };
  await hands.drag(handle, from, { x: from.x + px, y: from.y }, T);
  const until = Date.now() + settleMs;
  while (Date.now() < until) {
    if (!(await visible(handle))) return "ticked";
    await page.waitForTimeout(500);
  }
  return "again";
}

/**
 * Press and hold: the pointer goes to the button, the button stays down until it
 * is gone or stops asking (the challenge's own "done"), then lets go. Too short a
 * hold and HUMAN asks again: the next round holds again.
 */
async function hold(page: Page, hands: Hands, settleMs: number): Promise<Step> {
  const button = await holdButton(page);
  if (!button) return "ticked";
  await hands.think(page);
  const box = await button.boundingBox(T);
  if (!box) return "gave-up";
  await page.mouse.move(
    box.x + box.width * (0.4 + Math.random() * 0.2),
    box.y + box.height * (0.4 + Math.random() * 0.2),
    { steps: 12 },
  );
  await page.mouse.down();
  const until = Date.now() + settleMs * 2;
  let released = false;
  while (Date.now() < until) {
    await page.waitForTimeout(500);
    if (!(await holdButton(page))) {
      released = true;
      break;
    }
  }
  // Released a beat after the challenge answers, as a thumb would.
  await page.waitForTimeout(300 + Math.random() * 400);
  await page.mouse.up();
  if (released) return "ticked";
  await page.waitForTimeout(2_000);
  return (await holdButton(page)) ? "again" : "ticked";
}
