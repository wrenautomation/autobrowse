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

async function frameSections(
  frame: Frame,
  chain: string | null,
  depth: number,
  out: string[],
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  for (const child of frame.childFrames()) {
    const own = await selectorOf(child);
    if (!own) continue;
    const at = chain ? `${chain} >> internal:control=enter-frame >> ${own}` : own;
    const tree = await child
      .locator("body")
      .ariaSnapshot({ timeout: 3_000 })
      .catch(() => "");
    if (tree.trim())
      out.push(`- iframe ${JSON.stringify(at)}:`, ...tree.split("\n").map((l) => `  ${l}`));
    await frameSections(child, at, depth + 1, out);
  }
}

/** The page's snapshot, then each visible frame's under `- iframe "<chain>":`. */
export async function ariaWithFrames(page: Page): Promise<string> {
  const tree = await page.locator("body").ariaSnapshot();
  const sections: string[] = [];
  await frameSections(page.mainFrame(), null, 1, sections);
  return sections.length ? `${tree}\n${sections.join("\n")}` : tree;
}

/** The frame chain an outline section names: `- iframe "<chain>":` → chain. */
export function frameOfSection(name: string): string | null {
  return /internal:control=enter-frame|^i?frame\b/.test(name) ? name : null;
}
