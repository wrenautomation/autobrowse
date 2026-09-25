/**
 * Captchas: find one on the page and solve it the way a person would, with
 * the same hands (`browser/human`) every other act uses.
 *
 *   checkbox  "I'm not a robot" (reCAPTCHA, hCaptcha, Cloudflare Turnstile):
 *             one human click, then wait for the tick
 *   grid      "select all squares with traffic lights": the challenge is
 *             photographed, the eyes name the squares, the hands click them
 *             and press Verify; new squares fading in are looked at again
 *   text      a picture of letters beside a box: the eyes read, the hands type
 *   slider    a puzzle piece to drag into its gap: the eyes say how far
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

export type CaptchaKind = "checkbox" | "grid" | "text" | "slider";
export type CaptchaVendor = "recaptcha" | "hcaptcha" | "turnstile" | "generic";

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

const visible = (l: Locator) =>
  l
    .first()
    .isVisible()
    .catch(() => false);

/** The captcha on the page, the challenge before its checkbox (an open challenge is what is asked now). */
export async function findCaptcha(page: Page): Promise<Captcha | null> {
  if (await visible(page.locator(RECAPTCHA.bframe))) return { kind: "grid", vendor: "recaptcha" };
  if (await visible(page.locator(HCAPTCHA.bframe))) return { kind: "grid", vendor: "hcaptcha" };
  if (await visible(page.locator(RECAPTCHA.anchor)))
    return { kind: "checkbox", vendor: "recaptcha" };
  if (await visible(page.locator(HCAPTCHA.anchor))) return { kind: "checkbox", vendor: "hcaptcha" };
  if (await visible(page.locator(TURNSTILE.frame)))
    return { kind: "checkbox", vendor: "turnstile" };
  if (await visible(page.locator(GENERIC.slider))) return { kind: "slider", vendor: "generic" };
  if (
    (await visible(page.locator(GENERIC.picture))) &&
    (await visible(page.locator(GENERIC.input)))
  )
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
    if (now.kind !== "checkbox" && !o.eyes)
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
    const frame = page.frameLocator(TURNSTILE.frame).first();
    await hands.click(frame.locator(TURNSTILE.box).first(), T).catch(() => undefined);
    const until = Date.now() + settleMs * 2;
    while (Date.now() < until) {
      const token = await page
        .locator(TURNSTILE.response)
        .first()
        .inputValue()
        .catch(() => "");
      if (token) return "ticked";
      if (!(await visible(page.locator(TURNSTILE.frame)))) return "ticked";
      await page.waitForTimeout(500);
    }
    return "again";
  }
  const parts = vendor === "hcaptcha" ? HCAPTCHA : RECAPTCHA;
  const frame = page.frameLocator(parts.anchor).first();
  await hands.think(page);
  await hands.click(frame.locator(parts.box), T);
  const until = Date.now() + settleMs;
  while (Date.now() < until) {
    if (await visible(frame.locator(parts.ticked))) return "ticked";
    if (await visible(page.locator(parts.bframe))) return "again";
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
  const frame: FrameLocator = page.frameLocator(parts.bframe).first();
  // reCAPTCHA fades new squares in where clicked ones were: look again until none is left.
  for (let look = 0; look < 4; look++) {
    const tiles = frame.locator(parts.tiles);
    const count = await tiles.count();
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
    if (!(await visible(page.locator(parts.bframe)))) return "ticked";
    await page.waitForTimeout(500);
  }
  // Still open: a wrong pick or a fresh challenge; the next round looks again.
  return "again";
}

async function readLetters(page: Page, hands: Hands, eyes: Eyes): Promise<Step> {
  const png = await page
    .locator(GENERIC.picture)
    .first()
    .screenshot({ ...T, type: "png" });
  const answer = await eyes.look(
    png,
    'A text captcha: the letters and digits in the picture, exactly as shown (case matters). Reply {"text":"..."}.',
  );
  const text = /"text"\s*:\s*"([^"]{1,20})"/.exec(answer)?.[1]?.trim();
  if (!text) return "gave-up";
  await hands.type(page.locator(GENERIC.input).first(), text, T);
  // The form's own submit is the flow's to press: a text captcha is one field of it.
  return "ticked";
}

async function slide(page: Page, hands: Hands, eyes: Eyes, settleMs: number): Promise<Step> {
  const handle = page.locator(GENERIC.slider).first();
  const puzzle = page.locator(GENERIC.puzzle).first();
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
