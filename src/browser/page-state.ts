/**
 * What a page shows, said in a few words for an error: "still loading",
 * a wall, the error it prints, or its first words. A failure that only
 * says "no button" leaves the reader to open the screenshot; this says
 * why (2026-10-02: Notion and Todoist were both on their loading spinner).
 */
import type { FlowPage } from "./flow.js";
import { wallOf } from "./session.js";

const ERRORS =
  /something went wrong|an error occurred|error:|try again|not allowed|access denied|blocked|unsupported browser|couldn't sign you in|this browser or app may not be secure|too many requests/i;

/** True while the page is a spinner: no words, or a "Loading" line first (Notion's, Todoist's blank). */
export function isLoading(text: string): boolean {
  const words = text.replace(/\s+/g, " ").trim();
  return words.length < 3 || /^(loading|please wait|redirecting)\b/i.test(words);
}

/** The page in a few words: its wall, its error line, a spinner, or what it starts with. */
export function describePage(url: string, text: string): string {
  const where = url.replace(/[?#].*$/, "");
  const wall = wallOf(url, text);
  if (wall?.kind === "captcha") return `a bot check at ${where}`;
  const flat = text.replace(/\s+/g, " ").trim();
  const err = ERRORS.exec(flat);
  if (err) {
    const from = Math.max(0, err.index - 40);
    return `${where} says "${flat.slice(from, err.index + 80).trim()}"`;
  }
  if (isLoading(flat)) return `${where} is still loading (a blank page or spinner)`;
  return `${where} shows "${flat.slice(0, 80)}"`;
}

/** `describePage` for the page a flow is on now. */
export async function pageState(fp: FlowPage): Promise<string> {
  return describePage(fp.url(), await fp.text().catch(() => ""));
}

/** Wait while the page is a spinner, up to `ms`; true once it shows words. */
export async function untilLoaded(fp: FlowPage, ms: number): Promise<boolean> {
  // Counted in the page's own waits, so a fake page's clock drives it too.
  for (let waited = 0; ; waited += 1_000) {
    if (!isLoading(await fp.text().catch(() => ""))) return true;
    if (waited >= ms) return false;
    await fp.wait(1_000);
  }
}
