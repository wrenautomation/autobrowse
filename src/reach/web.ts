/**
 * The open web for research: read one page as lean text, search for pages.
 * Each is an ordered list of backends (Agent-Reach's idea): the first that
 * answers wins, one that is not set up is skipped, and a broken one is
 * rerouted around by reordering the list, not by new code. Keys are read by
 * name (EXA_API_KEY, BRAVE_API_KEY, JINA_API_KEY) and only ever sent in a
 * header; a backend without its key is skipped, never an error.
 */

export type Env = (name: string) => Promise<string | undefined>;

export interface Tried {
  via: string;
  why: string;
}

export interface Page {
  url: string;
  title: string | null;
  text: string;
  via: string;
  /** Characters cut off the end to stay under `max`. */
  cut: number;
  tried: Tried[];
}

export interface Hit {
  title: string;
  url: string;
  snippet: string | null;
}

export interface Hits {
  query: string;
  hits: Hit[];
  via: string;
  tried: Tried[];
}

interface Deps {
  env: Env;
  fetch?: typeof fetch;
}

/** A desktop browser's name: some sites answer a bare fetch with a bot page. */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const TIMEOUT_MS = 30_000;

class Skip extends Error {}

/**
 * No backend could answer, or the caller named one that does not exist: a final
 * answer, not a blip to retry. 501 when every backend was skipped (no key set),
 * 502 when they ran and failed, 400 for an unknown `via`.
 */
export class WebMiss extends Error {
  readonly status: 400 | 501 | 502;
  constructor(message: string, status: 400 | 501 | 502) {
    super(message);
    this.name = "WebMiss";
    this.status = status;
  }
}

async function get(f: typeof fetch, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

/** Try each backend in order; the first that answers wins. */
async function firstOf<T>(
  order: readonly string[],
  run: Record<string, () => Promise<T>>,
): Promise<{ value: T; via: string; tried: Tried[] }> {
  const tried: Tried[] = [];
  for (const via of order) {
    const go = run[via];
    if (!go) throw new WebMiss(`no backend ${via}; there are ${Object.keys(run).join(", ")}`, 400);
    try {
      return { value: await go(), via, tried };
    } catch (e) {
      const cause = e instanceof Error && e.cause ? ` (${String(e.cause)})` : "";
      tried.push({
        via,
        why: e instanceof Skip ? `skipped: ${e.message}` : `${String(e)}${cause}`,
      });
    }
  }
  const skipped = tried.every((t) => t.why.startsWith("skipped:"));
  throw new WebMiss(
    `nothing answered: ${tried.map((t) => `${t.via} (${t.why})`).join("; ")}`,
    skipped ? 501 : 502,
  );
}

/* ---------------- read ---------------- */

export const READ_ORDER = ["jina", "fetch"] as const;

/** A URL carrying what looks like a credential never goes to a third party. */
const PRIVATE_QUERY = /[?&](token|key|sig|signature|code|auth|session|password)=/i;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};
const decode = (s: string) =>
  s
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ENTITIES[e] ?? "")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)));

/** HTML to plain text a person would read: no scripts, headings marked, blocks on their own lines. */
export function htmlText(html: string): { title: string | null; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const body = html
    .replace(/<(script|style|noscript|svg|template|head|title)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<h([1-6])[^>]*>/gi, (_, n: string) => `\n\n${"#".repeat(Number(n))} `)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decode(body)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l, i, all) => l || all[i - 1])
    .join("\n")
    .trim();
  return { title: title ? decode(title).trim() : null, text };
}

export async function readPage(
  url: string,
  deps: Deps,
  o: { order?: readonly string[]; max?: number } = {},
): Promise<Page> {
  const f = deps.fetch ?? fetch;
  const max = o.max ?? 20_000;
  const run: Record<string, () => Promise<{ title: string | null; text: string }>> = {
    jina: async () => {
      if (PRIVATE_QUERY.test(url)) throw new Skip("the URL carries a credential");
      const key = await deps.env("JINA_API_KEY");
      const res = await get(f, `https://r.jina.ai/${url}`, {
        headers: {
          Accept: "application/json",
          "X-Retain-Images": "none",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
      });
      const body = (await res.json()) as { data?: { title?: string; content?: string } };
      const text = body.data?.content?.trim();
      if (!text) throw new Error("empty page");
      return { title: body.data?.title || null, text };
    },
    fetch: async () => {
      const res = await get(f, url, { headers: { "User-Agent": UA, Accept: "text/html,*/*" } });
      const type = res.headers.get("content-type") ?? "";
      const raw = await res.text();
      const got =
        /html/i.test(type) || /^\s*</.test(raw) ? htmlText(raw) : { title: null, text: raw };
      if (!got.text) throw new Error("empty page");
      return got;
    },
  };
  const { value, via, tried } = await firstOf(o.order ?? READ_ORDER, run);
  const cut = Math.max(0, value.text.length - max);
  return { url, title: value.title, text: value.text.slice(0, max), via, cut, tried };
}

/* ---------------- search ---------------- */

export const SEARCH_ORDER = ["exa", "brave", "duckduckgo"] as const;

const plain = (s: string) =>
  decode(s.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();

/** DuckDuckGo's no-script results page: real results only, ads left out. */
export function duckduckgoHits(html: string): Hit[] {
  const hits: Hit[] = [];
  for (const block of html.split(/(?=<div[^>]+class="[^"]*\bresult\b)/).slice(1)) {
    if (/result--ad/.test(block.slice(0, 200))) continue;
    const a = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a?.[1] || !a[2]) continue;
    const href = decode(a[1]);
    const target = href.includes("uddg=")
      ? decodeURIComponent(href.split("uddg=")[1]?.split("&")[0] ?? "")
      : href.startsWith("//")
        ? `https:${href}`
        : href;
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)?.[1];
    hits.push({ title: plain(a[2]), url: target, snippet: snippet ? plain(snippet) : null });
  }
  return hits;
}

export async function search(
  query: string,
  deps: Deps,
  o: { order?: readonly string[]; n?: number } = {},
): Promise<Hits> {
  const f = deps.fetch ?? fetch;
  const n = o.n ?? 10;
  const keyOf = async (name: string) => {
    const key = await deps.env(name);
    if (!key) throw new Skip(`no ${name}`);
    return key;
  };
  const run: Record<string, () => Promise<Hit[]>> = {
    exa: async () => {
      const key = await keyOf("EXA_API_KEY");
      const res = await get(f, "https://api.exa.ai/search", {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ query, numResults: n, type: "auto" }),
      });
      const body = (await res.json()) as { results?: Array<{ title?: string; url: string }> };
      return (body.results ?? []).map((r) => ({
        title: r.title ?? r.url,
        url: r.url,
        snippet: null,
      }));
    },
    brave: async () => {
      const key = await keyOf("BRAVE_API_KEY");
      const q = new URLSearchParams({ q: query, count: String(Math.min(n, 20)) });
      const res = await get(f, `https://api.search.brave.com/res/v1/web/search?${q}`, {
        headers: { "X-Subscription-Token": key, Accept: "application/json" },
      });
      const body = (await res.json()) as {
        web?: { results?: Array<{ title: string; url: string; description?: string }> };
      };
      return (body.web?.results ?? []).map((r) => ({
        title: plain(r.title),
        url: r.url,
        snippet: r.description ? plain(r.description) : null,
      }));
    },
    duckduckgo: async () => {
      const res = await get(
        f,
        `https://html.duckduckgo.com/html/?${new URLSearchParams({ q: query })}`,
        {
          headers: { "User-Agent": UA },
        },
      );
      const hits = duckduckgoHits(await res.text());
      if (!hits.length) throw new Error("no results (or a bot check)");
      return hits.slice(0, n);
    },
  };
  const { value, via, tried } = await firstOf(o.order ?? SEARCH_ORDER, run);
  return { query, hits: value, via, tried };
}
