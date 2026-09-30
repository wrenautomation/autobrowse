/**
 * One question to Perplexity on its web page, signed in (the page answers
 * no one signed out: "Sign up and repeat your request"). The API leg is
 * paid; this leg is the free plan's (`perplexity POST /chat/completions`).
 *
 * Mapped 2026-09-29 in explore (william@ via Google). The session dies
 * with the browser, so each run asks the session endpoint first and signs
 * in through the runner (`auth/sites.ts`) when it is gone. `/search?q=`
 * asks and lands on `/search/<thread id>`; the answer streams into
 * `main .prose`, its inline chips (`.citation`: a site name, "+2") cut out. The sources are the "Links" tab, one anchor each, its text
 * four lines: site, url, title, snippet.
 */
import { perplexitySignedIn } from "../../auth/sites.js";
import { defineFlow, type FlowPage } from "../flow.js";

export const PERPLEXITY = "https://www.perplexity.ai";
const LAND_MS = 15_000;
const ANSWER_MS = 120_000;
const SETTLE_MS = 2_000;
const SOURCES_MS = 5_000;

export interface AskInput {
  q: string;
}

export interface AskSource {
  site: string;
  url: string;
  title: string | null;
  snippet: string | null;
}

export interface Asked {
  query: string;
  /** The answer as text, citation chips cut out. */
  text: string;
  sources: AskSource[];
  /** The thread's page (private to the account). */
  thread: string;
}

/** The answer's text, chips cut out; "" until it starts. */
export const ANSWER_SCRIPT = `(() => {
  const p = document.querySelector("main .prose");
  if (!p) return "";
  const c = p.cloneNode(true);
  c.querySelectorAll("[data-pplx-citation], .citation, button, svg, img").forEach((e) => e.remove());
  c.style.cssText = "position:fixed;left:-99999px;top:0;width:800px";
  document.body.appendChild(c);
  const t = c.innerText;
  c.remove();
  return t.split("\\n").map((l) => l.replace(/[ \\t]+$/, "")).join("\\n").replace(/\\n{3,}/g, "\\n\\n").trim();
})()`;

/** Each source card's four lines: site, url, title, snippet. */
export const SOURCES_SCRIPT = `(() => {
  const panel = document.querySelector("[role=tabpanel][id$=content-sources]");
  if (!panel) return [];
  return [...panel.querySelectorAll("a[href^=http]")].map((a) => [a.href, ...a.innerText.split("\\n").map((s) => s.trim()).filter(Boolean)]);
})()`;

/**
 * A card's title without the breadcrumb Perplexity glues on the front
 * ("churnkey.co › guides › reactivation-campaignsWhat is…"): the host,
 * then each path segment behind a › or ·, as the URL spells them.
 */
export function titleOf(raw: string, url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return raw;
  }
  const host = [u.hostname, u.hostname.replace(/^www\./, "")].find((h) => raw.startsWith(h));
  if (!host) return raw;
  let rest = raw.slice(host.length);
  for (const seg of u.pathname.split("/").filter(Boolean)) {
    const sep = rest.match(/^\s*[›·]\s*/)?.[0];
    const word = decoded(seg);
    if (!sep || !rest.slice(sep.length).startsWith(word)) break;
    rest = rest.slice(sep.length + word.length);
  }
  return rest.trim() || raw;
}

/** A path segment as a person reads it; a stray `%` keeps it raw. */
function decoded(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** Source cards from their lines; a card with no url line is its anchor's href. */
export function sourcesOf(cards: string[][]): AskSource[] {
  const seen = new Set<string>();
  const out: AskSource[] = [];
  for (const [href, site = "", ...rest] of cards) {
    if (!href || seen.has(href)) continue;
    seen.add(href);
    const lines = rest[0] && /^https?:\/\//.test(rest[0]) ? rest.slice(1) : rest;
    out.push({
      site,
      url: href,
      title: lines[0] ? titleOf(lines[0], href) : null,
      snippet: lines[1] ?? null,
    });
  }
  return out;
}

export const askUrl = (q: string): string => `${PERPLEXITY}/search?${new URLSearchParams({ q })}`;

const THREAD = /perplexity\.ai\/search\/[\w-]+/;

/** Asked by URL; when the page drops the query (it went home), typed into the box. */
async function ask(fp: FlowPage, q: string): Promise<void> {
  await fp.open(`${PERPLEXITY}/`);
  if (!(await perplexitySignedIn(fp))) {
    const got = await fp.signIn("perplexity");
    if (got !== "signed-in" || !(await perplexitySignedIn(fp)))
      fp.human(`perplexity: signed out and the sign-in did not take (${got})`);
  }
  await fp.open(askUrl(q));
  if (await fp.waitForUrl(THREAD, LAND_MS)) return;
  const box = { role: "textbox" } as const;
  await fp.act({ kind: "fill", value: q }, box, { goal: "type the question" });
  await fp.act({ kind: "press", key: "Enter" }, box, { goal: "ask" });
  if (!(await fp.waitForUrl(THREAD, LAND_MS)))
    throw new Error(`perplexity: the question did not open a thread (${fp.url()})`);
}

/** The answer once it stops growing, or what there is at `ANSWER_MS`. */
async function answered(fp: FlowPage): Promise<string> {
  let last = "";
  for (let t = 0; t < ANSWER_MS; t += SETTLE_MS) {
    await fp.wait(SETTLE_MS);
    const now = await fp.page.evaluate<string>(ANSWER_SCRIPT);
    if (now && now === last) return now;
    last = now;
  }
  if (!last) throw new Error(`perplexity: no answer in ${ANSWER_MS / 1000}s (${fp.url()})`);
  return last;
}

export const perplexityAsk = defineFlow<AskInput, Asked>({
  site: "perplexity",
  name: "ask",
  async run(fp, input) {
    await ask(fp, input.q);
    const text = await answered(fp);
    const at = fp.url().match(THREAD)?.[0];
    const thread = at ? `https://www.${at}` : fp.url();
    await fp.act({ kind: "click" }, { role: "tab", name: "Links" }, { goal: "open the sources" });
    let cards: string[][] = [];
    for (let t = 0; t < SOURCES_MS && !cards.length; t += 500) {
      await fp.wait(500);
      cards = await fp.page.evaluate<string[][]>(SOURCES_SCRIPT);
    }
    return { query: input.q, text, sources: sourcesOf(cards), thread };
  },
});
