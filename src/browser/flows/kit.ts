/**
 * Small moves the hand-written flows share. Each was copied between two or three flows
 * before it lived here; a flow passes in what differs (its page's words, its selectors).
 */
import type { FlowPage } from "../flow.js";
import type { Hints } from "../locate.js";

/** How long a page gets to render, and how often it is looked at meanwhile. */
export const RENDER_MS = 15_000;
export const SETTLE_MS = 1_000;

/** Which of `hints` shows first within the render time; "missing" when the page says so (`missing`). */
export async function firstShown(
  fp: FlowPage,
  hints: Hints[],
  missing: RegExp,
): Promise<number | "missing" | null> {
  for (let i = 0; i < RENDER_MS / SETTLE_MS; i++) {
    for (const [n, h] of hints.entries()) if (await fp.has(h)) return n;
    if (missing.test(await fp.text())) return "missing";
    await fp.wait(SETTLE_MS);
  }
  return null;
}

/** A captcha in `frame` is solved before the click it guards; one a solver cannot pass goes to a person. */
export async function passCaptcha(fp: FlowPage, frame: Hints, what: string): Promise<void> {
  if (!(await fp.has(frame, 2_000))) return;
  const got = await fp.captcha();
  if (!got.solved) fp.human(`${what} is a person's (${got.reason})`);
}

/** Scroll the list `script` finds to its end (it answers whether it moved one); else the page. */
export async function scrollList(fp: FlowPage, script: string): Promise<void> {
  const moved = await fp.page.evaluate<boolean>(script).catch(() => false);
  if (!moved) await fp.scroll(1_500);
}

/** The links the page's HTML holds, as `url` makes them from each match's first group, each once. */
export async function linksOn(
  fp: { html(): Promise<string> },
  href: RegExp,
  url: (path: string) => string,
): Promise<string[]> {
  const html = await fp.html();
  const out: string[] = [];
  for (const m of html.matchAll(href)) {
    const u = url(m[1] ?? "");
    if (!out.includes(u)) out.push(u);
  }
  return out;
}
