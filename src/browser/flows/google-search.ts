/**
 * A Google search as a person sees it: the AI Overview (its answer and the
 * sources it cites), every organic result, the ads, and "People also ask".
 * Google has no search API for new callers, and its page is the thing worth
 * auditing, so this is a browser leg (`web GET /google`). Google answers a
 * datacenter IP with /sorry (a reCAPTCHA), so it runs on the Mac's desk.
 *
 * Mapped 2026-09-29 in explore, signed out. Result links are `/goto?url=<an
 * opaque token>`: the target is not in the page, so each one is resolved by
 * one request that reads the redirect and never loads the target. The AI
 * Overview streams in after the results and hides half its answer behind
 * "Show more"; its inline chips (a site name, "+1") and its source cards
 * ("<title>. Opens in new tab.", or "<title>, Video, watch on YouTube") are
 * cut out of the answer and returned as `sources`; the cards render last, so
 * the read repeats until they are in and the answer stops growing. Class names are Google's obfuscated ones, so each read has a
 * structural fallback (an `a h3`, the longest text block, a `data-q`).
 */
import { defineFlow, type FlowPage } from "../flow.js";

export const GOOGLE = "https://www.google.com";
const RESULTS_MS = 15_000;
/** The Overview streams in after the results; past this it is not coming. */
const OVERVIEW_MS = 6_000;
const SETTLE_MS = 800;
const PER_PAGE = 10;
const MAX_PAGES = 3;
const RESOLVE_AT_ONCE = 6;

export interface SearchInput {
  q: string;
  /** Organic results wanted, 1-30: past 10, the next pages are read too. */
  n?: number;
  /** Interface language (`hl`), default en. */
  hl?: string;
  /** Country (`gl`), e.g. us or ca; unset, Google picks by IP. */
  gl?: string;
}

export interface Source {
  title: string;
  url: string | null;
}

export interface Overview {
  /** The answer as text, chips and source cards cut out. */
  text: string;
  sources: Source[];
}

export interface Result {
  position: number;
  title: string;
  url: string | null;
  /** The site's name as Google shows it: "Mailshake". */
  site: string | null;
  /** The breadcrumb Google shows: "https://www.signitic.com › Home › Resources". */
  shown: string | null;
  snippet: string | null;
  /** The date Google prints before the snippet: "Aug 21, 2026". */
  date: string | null;
}

export interface Ad {
  title: string;
  url: string | null;
  shown: string | null;
}

export interface Serp {
  query: string;
  overview: Overview | null;
  results: Result[];
  ads: Ad[];
  /** "People also ask". */
  questions: string[];
}

/** What the page script reads, hrefs still Google's. */
export interface RawSerp {
  overview: { text: string; sources: Array<{ title: string; href: string }> } | null;
  results: Array<{
    title: string;
    href: string;
    site: string | null;
    shown: string | null;
    snippet: string | null;
    date: string | null;
  }>;
  ads: Array<{ title: string; href: string; shown: string | null }>;
  questions: string[];
}

/**
 * Runs in the page. A string, not a function: the project compiles without
 * lib dom. Finds the Overview by its heading and widens to the block around
 * it; reads it in a rendered offscreen copy so `innerText` keeps the lines.
 */
export const SERP_SCRIPT = `(() => {
  const clean = (s) => (s || "").replace(/[ \\t\\u00a0]+/g, " ").replace(/\\n{3,}/g, "\\n\\n").trim();
  const heading = [...document.querySelectorAll("h1,h2,h3,strong,span,div")]
    .find((e) => e.children.length === 0 && /^AI Overview$/.test(e.textContent.trim()));
  let root = heading;
  while (root && root.innerText.length < 200) root = root.parentElement;
  while (root && root.parentElement && root.parentElement.innerText.length <= root.innerText.length * 1.05
    && !root.parentElement.querySelector("a h3")) root = root.parentElement;
  let overview = null;
  if (root) {
    const CARD = /(\\.?\\s*Opens in new tab\\.?|, Video, watch on YouTube)$/;
    const cards = [...root.querySelectorAll("a[aria-label]")].filter((a) => CARD.test(a.getAttribute("aria-label")));
    const seen = new Set();
    const sources = [];
    for (const a of cards) {
      const title = a.getAttribute("aria-label").replace(CARD, "").trim();
      const href = a.getAttribute("href") || "";
      // Google's own help ("Learn more about AI Mode") is not a source.
      const own = /^https?:\\/\\/[^/]*google\\./.test(href) && !/\\/(goto|url)\\?/.test(href);
      if (!title || own || seen.has(title)) continue;
      seen.add(title);
      sources.push({ title, href });
    }
    const copy = root.cloneNode(true);
    copy.style.cssText = "position:absolute;left:-99999px;top:0;width:700px";
    for (const a of copy.querySelectorAll("a[aria-label]")) {
      if (CARD.test(a.getAttribute("aria-label"))) (a.closest("li") || a).remove();
      else a.remove(); // a citation chip: the site's name
    }
    // An entity link inside the answer ("Frontal AI") keeps its words.
    for (const e of copy.querySelectorAll("[role=button], button, svg, img, style, script")) e.remove();
    document.body.appendChild(copy);
    const lines = copy.innerText.split("\\n").map((l) => l.trim())
      .filter((l) => l && !/^(AI Overview|Show (all|more|less)|About this response|·|\\+\\d+|AI responses may include mistakes\\.?.*)$/.test(l));
    copy.remove();
    overview = { text: clean(lines.join("\\n")), sources };
  }
  const results = [];
  const hrefs = new Set();
  for (const h of document.querySelectorAll("#rso a h3, #search a h3")) {
    if (root && root.contains(h)) continue;
    const a = h.closest("a");
    const href = a && a.getAttribute("href");
    if (!href || hrefs.has(href)) continue;
    hrefs.add(href);
    const box = h.closest("[data-hveid]") || a.parentElement;
    const title = clean(h.innerText);
    const cite = box.querySelector("cite");
    const lead = box.querySelector("[data-sncf='1'], .VwiC3b");
    let snippet = lead ? lead.innerText : null;
    if (!snippet) {
      const blocks = [...box.querySelectorAll("div, span")].filter((e) => !e.querySelector("div") && !e.closest("a"));
      snippet = blocks.map((e) => e.innerText).filter((t) => t && !t.includes(title)).sort((x, y) => y.length - x.length)[0] || null;
    }
    const dated = snippet && snippet.match(/^([A-Z][a-z]{2} \\d{1,2}, \\d{4}|\\d+ (?:hours?|days?|weeks?) ago) — /);
    results.push({
      title,
      href,
      site: clean(box.querySelector(".VuuXrf") && box.querySelector(".VuuXrf").innerText) || null,
      shown: cite ? clean(cite.innerText) : null,
      snippet: snippet ? clean(dated ? snippet.slice(dated[0].length) : snippet).replace(/\\s*Read more$/, "") : null,
      date: dated ? dated[1] : null,
    });
  }
  const ads = [...document.querySelectorAll("[data-text-ad]")].map((ad) => {
    const a = ad.querySelector("a[data-pcu], a[href]");
    const pcu = a && a.getAttribute("data-pcu");
    return {
      title: clean((ad.querySelector("[role=heading]") || ad).innerText.split("\\n")[0]),
      href: pcu ? pcu.split(",")[0] : (a && a.getAttribute("href")) || "",
      shown: clean(ad.querySelector("cite") && ad.querySelector("cite").innerText) || null,
    };
  });
  const questions = [...new Set([...document.querySelectorAll("[data-q]")].map((e) => clean(e.getAttribute("data-q"))))].filter(Boolean);
  return { overview, results, ads, questions };
})()`;

/** The search URL for one page of results. */
export function searchUrl(i: SearchInput, page = 0): string {
  const q = new URLSearchParams({ q: i.q, hl: i.hl ?? "en" });
  if (i.gl) q.set("gl", i.gl);
  if (page) q.set("start", String(page * PER_PAGE));
  return `${GOOGLE}/search?${q}`;
}

/**
 * Where a result link goes. A plain link is itself; `/url?q=` carries it;
 * `/goto?url=` does not, so the resolver asks Google (one request, the
 * redirect read, the target never loaded). Null when nothing says.
 */
export async function targetOf(
  href: string,
  resolve: (abs: string) => Promise<string | null>,
): Promise<string | null> {
  if (!href) return null;
  const abs = new URL(href, GOOGLE);
  if (!/(^|\.)google\.[a-z.]+$/.test(abs.hostname)) return abs.href;
  if (abs.pathname === "/url") return abs.searchParams.get("q") ?? abs.searchParams.get("url");
  if (abs.pathname === "/goto" || abs.pathname === "/aclk") return resolve(abs.href);
  return abs.href;
}

/** A redirect's target from its answer: the Location header, else a refresh or script in the body. */
export function redirectTarget(location: string | undefined, body: string): string | null {
  const found =
    location ??
    body.match(/<meta\b(?=[^>]*http-equiv=["']?refresh)[^>]*url=([^"'>]+)/i)?.[1] ??
    body.match(/location\.replace\(["']([^"']+)["']\)/)?.[1] ??
    null;
  if (!found) return null;
  const url = found.replace(/&amp;/g, "&").replace(/\\x3d/g, "=").replace(/\\x26/g, "&");
  return /^https?:\/\//.test(url) ? url : null;
}

/** Every href once, a few at a time; a miss is null, never an error. */
async function resolveAll(
  hrefs: string[],
  resolve: (abs: string) => Promise<string | null>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const todo = [...new Set(hrefs)];
  const next = async () => {
    for (let h = todo.shift(); h !== undefined; h = todo.shift())
      out.set(h, await targetOf(h, resolve).catch(() => null));
  };
  await Promise.all(Array.from({ length: RESOLVE_AT_ONCE }, next));
  return out;
}

/** Pages of raw reads into one Serp: results numbered and cut to `n`, links resolved. */
export async function serpOf(
  query: string,
  pages: RawSerp[],
  n: number,
  resolve: (abs: string) => Promise<string | null>,
): Promise<Serp> {
  const first = pages[0];
  const seen = new Set<string>();
  const results = pages
    .flatMap((p) => p.results)
    .filter((r) => !seen.has(r.href) && seen.add(r.href))
    .slice(0, n);
  const ads = pages.flatMap((p) => p.ads);
  const sources = first?.overview?.sources ?? [];
  const urls = await resolveAll(
    [...results.map((r) => r.href), ...ads.map((a) => a.href), ...sources.map((s) => s.href)],
    resolve,
  );
  const at = (h: string) => urls.get(h) ?? null;
  return {
    query,
    overview: first?.overview
      ? {
          text: first.overview.text,
          sources: sources.map((s) => ({ title: s.title, url: at(s.href) })),
        }
      : null,
    results: results.map(({ href, ...r }, i) => ({ position: i + 1, ...r, url: at(href) })),
    ads: ads.map(({ href, ...a }) => ({ ...a, url: at(href) })),
    questions: [...new Set(pages.flatMap((p) => p.questions))].filter(
      (q) => q.toLowerCase() !== query.toLowerCase(),
    ),
  };
}

/**
 * Google's own words for a query with no match (asked in English, the default
 * `hl`). "No results found for" is the quoted query's miss: what follows is a
 * looser query's results (quotes dropped), not answers to the one asked.
 * Whole lines only, so a snippet quoting the phrase does not count.
 */
const NO_MATCH = /^(Your search - .+ - did not match any documents\.|No results found for .+\.)$/m;

export const noMatch = (pageText: string): boolean => NO_MATCH.test(pageText);

/** In the page: "none" for Google's no-match page, "results" once the results column is in, else null. */
export const LANDED_SCRIPT = `(() => {
  const text = document.body ? document.body.innerText : "";
  if (${NO_MATCH}.test(text)) return "none";
  return document.querySelector("#search, #rso") ? "results" : null;
})()`;

/** What the page settled into within `RESULTS_MS`: null when neither (a block, a wall, a slow load). */
async function landed(fp: FlowPage): Promise<"results" | "none" | null> {
  for (let t = 0; t < RESULTS_MS; t += SETTLE_MS) {
    const got = await fp.page.evaluate<"results" | "none" | null>(LANDED_SCRIPT);
    if (got) return got;
    await fp.wait(SETTLE_MS);
  }
  return null;
}

const NOTHING: RawSerp = { overview: null, results: [], ads: [], questions: [] };

/** Past Google's /sorry check (a reCAPTCHA), or a person's. */
async function pastSorry(fp: FlowPage): Promise<void> {
  if (!/\/sorry\//.test(fp.url())) return;
  const got = await fp.captcha();
  if (!got.solved) fp.human(`google: the "unusual traffic" check is a person's (${got.reason})`);
  if (/\/sorry\//.test(fp.url()))
    fp.human("google: still on the unusual-traffic page after the captcha");
}

/** "Show more" inside the Overview, if it is folded; then let it settle. */
async function unfoldOverview(fp: FlowPage): Promise<void> {
  const clicked = await fp.page.evaluate<boolean>(`(() => {
    const heading = [...document.querySelectorAll("h1,h2,h3,strong,span,div")]
      .find((e) => e.children.length === 0 && /^AI Overview$/.test(e.textContent.trim()));
    let root = heading;
    while (root && root.innerText.length < 200) root = root.parentElement;
    const more = root && [...root.querySelectorAll("[role=button], button")]
      .find((b) => b.innerText.trim() === "Show more" && b.getAttribute("aria-expanded") !== "true");
    if (more) more.click();
    return Boolean(more);
  })()`);
  if (clicked) await fp.wait(SETTLE_MS);
}

async function readPage(fp: FlowPage, url: string, overview: boolean): Promise<RawSerp> {
  await fp.open(url);
  await pastSorry(fp);
  if (await fp.has({ role: "button", name: "/^accept all$/i" }, 1_000))
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^accept all$/i" },
      { goal: "cookies" },
    );
  // A query nothing matches is an answer (no results), not a failure: 7 of 12 site: lookups were (2026-10-03).
  const got = await landed(fp);
  if (got === "none") return NOTHING;
  if (got === null) throw new Error(`google: no results page at ${fp.url()}`);
  if (!overview || !(await fp.has({ text: "AI Overview" }, OVERVIEW_MS)))
    return fp.page.evaluate<RawSerp>(SERP_SCRIPT);
  await unfoldOverview(fp);
  return settled(fp);
}

/** Reads until the Overview's source cards are in and its answer stops growing, or `OVERVIEW_MS` passes. */
async function settled(fp: FlowPage): Promise<RawSerp> {
  let last = await fp.page.evaluate<RawSerp>(SERP_SCRIPT);
  for (let t = 0; t < OVERVIEW_MS; t += SETTLE_MS) {
    await fp.wait(SETTLE_MS);
    const now = await fp.page.evaluate<RawSerp>(SERP_SCRIPT);
    const same = now.overview?.text.length === last.overview?.text.length;
    last = now;
    if (same && now.overview?.sources.length) break;
  }
  return last;
}

export const googleSearch = defineFlow<SearchInput, Serp>({
  site: "web",
  name: "google",
  async run(fp, input) {
    const n = Math.min(Math.max(input.n ?? PER_PAGE, 1), PER_PAGE * MAX_PAGES);
    const pages: RawSerp[] = [];
    for (let p = 0; p < Math.ceil(n / PER_PAGE); p++) {
      const raw = await readPage(fp, searchUrl(input, p), p === 0);
      pages.push(raw);
      if (!raw.results.length) break;
    }
    const request = fp.page.context().request;
    return serpOf(input.q, pages, n, async (abs) => {
      const res = await request.get(abs, { maxRedirects: 0, timeout: 10_000 });
      return redirectTarget(res.headers().location, res.status() === 200 ? await res.text() : "");
    });
  },
});
