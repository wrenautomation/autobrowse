/**
 * The page's aria snapshot with what its iframes hold. Playwright's
 * snapshot stops at an iframe (`- iframe`), so a captcha checkbox or an
 * embedded sign-in button is invisible to whoever reads it. Each visible
 * frame's tree is appended as its own section:
 *
 *   - iframe "iframe#captcha-internal >> internal:control=enter-frame >> iframe[title=\"reCAPTCHA\"]":
 *     - checkbox "I'm not a robot"
 *
 * The name is the frame's selector chain from the page, the `frame` hint
 * that finds anything inside it again (`page.frameLocator(chain)`).
 */
import type { Frame, Page } from "playwright";
import { type Hints, locateAll } from "./locate.js";

/** The DOM an iframe element shows us; no DOM lib in this build. */
interface FrameElement {
  tagName: string;
  id: string;
  title: string;
  name: string;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { width: number; height: number };
  ownerDocument: {
    querySelectorAll(sel: string): Iterable<unknown>;
    defaultView: {
      getComputedStyle(e: unknown): { visibility: string; display: string };
      CSS: { escape(s: string): string };
    } | null;
  };
}

/** Frames nested deeper than this are left out (ads nest; controls do not). */
const MAX_DEPTH = 3;

/**
 * How the parent finds this frame's element: id, title, name, then src
 * without its query, plus `nth` when that is not unique. Stable across
 * loads where possible: a recorded flow replays with it.
 */
async function selectorOf(frame: Frame): Promise<string | null> {
  const el = await frame.frameElement().catch(() => null);
  if (!el) return null;
  // No named helpers inside: tsx wraps them in `__name`, which the page does not have.
  return el
    .evaluate((node) => {
      const e = node as unknown as FrameElement;
      const r = e.getBoundingClientRect();
      const style = e.ownerDocument.defaultView?.getComputedStyle(e);
      if (!style) return null;
      if (r.width < 2 || r.height < 2 || style.visibility === "hidden" || style.display === "none")
        return null;
      const tag = e.tagName.toLowerCase();
      const src = e.getAttribute("src") ?? "";
      const sel = e.id
        ? `${tag}#${e.ownerDocument.defaultView?.CSS.escape(e.id) ?? e.id}`
        : e.title
          ? `${tag}[title=${JSON.stringify(e.title)}]`
          : e.name
            ? `${tag}[name=${JSON.stringify(e.name)}]`
            : src && !src.startsWith("javascript:")
              ? `${tag}[src^=${JSON.stringify(src.split("?")[0])}]`
              : tag;
      const all = [...e.ownerDocument.querySelectorAll(sel)];
      const k = all.indexOf(e);
      return all.length > 1 && k >= 0 ? `${sel} >> nth=${k}` : sel;
    })
    .catch(() => null)
    .finally(() => el.dispose());
}

/** Every visible frame, outermost first, with its selector chain from the page. */
async function visibleFrames(
  frame: Frame,
  chain: string | null,
  depth: number,
  out: Array<{ frame: Frame; chain: string }>,
): Promise<typeof out> {
  if (depth > MAX_DEPTH) return out;
  for (const child of frame.childFrames()) {
    const own = await selectorOf(child);
    if (!own) continue;
    const at = chain ? `${chain} >> internal:control=enter-frame >> ${own}` : own;
    out.push({ frame: child, chain: at });
    await visibleFrames(child, at, depth + 1, out);
  }
  return out;
}

/** The page's snapshot, then each visible frame's under `- iframe "<chain>":`. */
export async function ariaWithFrames(page: Page): Promise<string> {
  const tree = await page.locator("body").ariaSnapshot();
  const sections: string[] = [];
  for (const { frame, chain } of await visibleFrames(page.mainFrame(), null, 1, [])) {
    const own = await frame
      .locator("body")
      .ariaSnapshot({ timeout: 3_000 })
      .catch(() => "");
    if (own.trim())
      sections.push(`- iframe ${JSON.stringify(chain)}:`, ...own.split("\n").map((l) => `  ${l}`));
  }
  return sections.length ? `${tree}\n${sections.join("\n")}` : tree;
}

/**
 * Hints that name no frame and match nothing on the page, pointed at the
 * first visible frame that holds a match: a card field in a payment
 * provider's iframe (Braintree, Stripe) is found without the caller
 * reading the frame chain off the outline. Unchanged otherwise.
 */
export async function withFrame(page: Page, hints: Hints): Promise<Hints> {
  if (
    hints.frame ||
    (await locateAll(page, hints)
      .count()
      .catch(() => 0))
  )
    return hints;
  for (const { chain } of await visibleFrames(page.mainFrame(), null, 1, [])) {
    const inside = { ...hints, frame: chain };
    if (
      await locateAll(page, inside)
        .count()
        .catch(() => 0)
    )
      return inside;
  }
  return hints;
}

/** The frame chain an outline section names: `- iframe "<chain>":` → chain. */
export function frameOfSection(name: string): string | null {
  return /internal:control=enter-frame|^i?frame\b/.test(name) ? name : null;
}
