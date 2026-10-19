/**
 * HTML to the words a person reads, and whether a page has none yet (a JS shell).
 * Shared by `/read` (`reach/web.ts`) and the fetch ladder (`reach/ladder.ts`).
 */
import { decodeHTML } from "entities";

/** HTML to plain text a person would read: no scripts, headings marked, blocks on their own lines, table rows across. */
export function htmlText(html: string): { title: string | null; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const body = html
    .replace(/<(script|style|noscript|svg|template|head|title)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<h([1-6])[^>]*>/gi, (_, n: string) => `\n\n${"#".repeat(Number(n))} `)
    .replace(/<li[^>]*>/gi, "\n- ")
    // A table row reads across, its cells apart: `Plan | Price`.
    .replace(/<\/t[dh]>\s*(?=<t[dh][\s>])/gi, " | ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeHTML(body)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l, i, all) => l || all[i - 1])
    .join("\n")
    .trim();
  return { title: title ? decodeHTML(title).replace(/\s+/g, " ").trim() : null, text };
}

/** SPA mount-point and framework markers, checked against lowercased markup. */
const SHELL_MARKERS = [
  'id="root"',
  "id='root'",
  'id="app"',
  "id='app'",
  'id="__next"',
  "__next_data__",
  "data-reactroot",
  'id="___gatsby"',
  "ng-version=",
  'id="q-app"',
  "enable javascript",
  "requires javascript",
] as const;
const SHELL_MAX_TEXT = 200;
const SHELL_MIN_HTML = 2000;

/**
 * Is this page a JS mount point whose words live client-side? Thin text alone must
 * not fire (a tiny server-rendered contact page is real content): a shell is thin
 * text plus substantial, script-dominated markup or a framework mount marker.
 * Ported from wren `packages/research/src/fetch/htmltext.ts:206` (`looksLikeJsShell`).
 */
export function looksLikeJsShell(html: string, text: string): boolean {
  if (text.trim().length >= SHELL_MAX_TEXT) return false;
  if (html.length < SHELL_MIN_HTML) return false;
  const lowered = html.toLowerCase();
  if (SHELL_MARKERS.some((marker) => lowered.includes(marker))) return true;
  return lowered.split("<script").length - 1 >= 3;
}
