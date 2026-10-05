/**
 * The open web for research: read one page as lean text, search for pages.
 * Each is an ordered list of backends (Agent-Reach's idea): the first that
 * answers wins, one that is not set up is skipped, and a broken one is
 * rerouted around by reordering the list, not by new code. Keys are read by
 * name (EXA_API_KEY, BRAVE_API_KEY, JINA_API_KEY) and only ever sent in a
 * header; a backend without its key is skipped, never an error. Exa takes
 * several keys (`NUM_EXA`, `EXA_API_KEY_1..n`) and moves past one out of
 * credit (`key-ring.ts`).
 */
import { memorySpent, NoLiveKey, type SpentKeys, withKey } from "./key-ring.js";

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
  /** The backend's result as it came, every field: what to use is the caller's call. */
  raw?: unknown;
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
  /** Exa keys out of credit; absent, this process remembers them itself. */
  spent?: SpentKeys;
}

const processSpent = memorySpent();

/** One Exa call on the first key with credit left. A non-2xx answer comes back as is. */
const exaSend = (deps: Deps, path: string, body: unknown): Promise<Response> =>
  withKey("EXA", deps.env, deps.spent ?? processSpent, (key) =>
    (deps.fetch ?? fetch)(`https://api.exa.ai${path}`, {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
  );

/** Exa's answer as JSON, or the WebMiss a caller of an Exa-only route gets. */
async function exaJson(deps: Deps, path: string, body: unknown): Promise<unknown> {
  try {
    const res = await exaSend(deps, path, body);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e instanceof NoLiveKey)
      throw e.held
        ? new WebMiss(`nothing answered: exa (${e.message})`, 402)
        : new WebMiss("nothing answered: exa (skipped: no EXA_API_KEY)", 501);
    throw new WebMiss(`nothing answered: exa (${String(e)})`, 502);
  }
}

/** A desktop browser's name: some sites answer a bare fetch with a bot page. */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const TIMEOUT_MS = 30_000;

class Skip extends Error {}

/**
 * No backend could answer, or the caller named one that does not exist: a final
 * answer, not a blip to retry. 501 when every backend was skipped (no key set),
 * 502 when they ran and failed, 400 for an unknown `via` or a bad URL, 404 when
 * Exa's cache has no such page, 402 when every Exa key is out of credit.
 */
export class WebMiss extends Error {
  readonly status: 400 | 402 | 404 | 501 | 502;
  constructor(message: string, status: 400 | 402 | 404 | 501 | 502) {
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
  if (!order.length)
    throw new WebMiss(`no backend asked; there are ${Object.keys(run).join(", ")}`, 400);
  const unknown = order.find((via) => !run[via]);
  if (unknown)
    throw new WebMiss(`no backend ${unknown}; there are ${Object.keys(run).join(", ")}`, 400);
  const tried: Tried[] = [];
  for (const via of order) {
    const go = run[via] as () => Promise<T>;
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
      const res = await exaSend(deps, "/search", { query, numResults: n, type: "auto" }).catch(
        (e) => {
          throw e instanceof NoLiveKey ? new Skip(e.message) : e;
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { results?: Array<{ title?: string; url: string }> };
      return (body.results ?? []).map((r) => ({
        title: r.title ?? r.url,
        url: r.url,
        snippet: null,
        raw: r,
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
        raw: r,
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

/* ---------------- people ---------------- */

export interface Role {
  title: string;
  company: string;
  /** The company's LinkedIn page, when the profile links it. */
  companyUrl: string | null;
  current: boolean;
  /** "Jan 2025 - Present (1 year and 8 months)", as the profile says it. */
  dates: string | null;
}

export interface School {
  school: string;
  /** The school's LinkedIn page, when the profile links it. */
  schoolUrl: string | null;
  /** "BSc, Computer Science", when the entry names one. */
  degree: string | null;
  /** "2014 - 2018 (4 years) in Boulder", as the profile says it. */
  dates: string | null;
}

export interface Person {
  name: string;
  url: string;
  headline: string | null;
  location: string | null;
  /** "500", off "500 connections • 1,200 followers". */
  connections: string | null;
  about: string | null;
  /** Newest first, as the profile lists them. */
  roles: Role[];
  education: School[];
}

export interface People {
  query: string;
  people: Person[];
  via: string;
  /** Every result Exa sent, text and all, the ones that didn't parse as a person too. */
  raw: unknown[];
}

const LINK = /^\[([^\]]+)\]\(([^)]+)\)$/;
const RANGE_LINE = /^(?:[A-Z][a-z]{2} )?\d{4}( - |\b)/;
const CURRENT = /\s*\(Current\)\s*$/;
const DATES = /^(?:[A-Z][a-z]{2} )?\d{4} - /;

/** "[Acme](url)" or "Acme": the name and its link. */
function companyOf(raw: string): { company: string; companyUrl: string | null } {
  const s = raw.trim();
  const m = LINK.exec(s);
  return m
    ? { company: (m[1] ?? "").trim(), companyUrl: m[2] ?? null }
    : { company: s, companyUrl: null };
}

/**
 * One profile as Exa's people search writes it: `# Name`, the headline and
 * location lines, then `## Experience` with each role as `### Title - Company`
 * or a `### Company` group of `#### Title` roles; `(Current)` marks a role held
 * now, and the line after is its dates.
 */
export function exaProfile(text: string): Omit<Person, "url"> | null {
  const lines = text.split("\n").map((l) => l.trim());
  const name = lines
    .find((l) => l.startsWith("# "))
    ?.slice(2)
    .trim();
  if (!name) return null;
  const head = lines.slice(lines.indexOf(`# ${name}`) + 1).filter(Boolean);
  const body = (i: number) => {
    const l = head[i];
    return l && !l.startsWith("#") && !/connections|followers/.test(l) ? l : null;
  };
  const roles: Role[] = [];
  const start = lines.indexOf("## Experience");
  let group: { company: string; companyUrl: string | null } | null = null;
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i] ?? "";
      if (l.startsWith("## ")) break;
      const next = lines.slice(i + 1).find(Boolean) ?? "";
      const dates = DATES.test(next) ? next : null;
      if (l.startsWith("#### ") && group) {
        const title = l.slice(5);
        roles.push({
          title: title.replace(CURRENT, ""),
          ...group,
          current: CURRENT.test(title),
          dates,
        });
      } else if (l.startsWith("### ")) {
        const entry = l.slice(4);
        const current = CURRENT.test(entry);
        const plain = entry.replace(CURRENT, "");
        const at = plain.lastIndexOf(" - ");
        if (at > 0) {
          group = null;
          roles.push({
            title: plain.slice(0, at).trim(),
            ...companyOf(plain.slice(at + 3)),
            current,
            dates,
          });
        } else group = companyOf(plain);
      }
    }
  }
  const conns = /^([\d,]+\+?) connections/m.exec(text);
  return {
    name,
    headline: body(0),
    location: body(1),
    connections: conns?.[1] ?? null,
    about: prose(section(lines, "About")),
    roles,
    education: schoolsOf(section(lines, "Education")),
  };
}

/** The lines under `## <name>`, up to the next `## `; empty when there is none. */
function section(lines: string[], name: string): string[] {
  const start = lines.indexOf(`## ${name}`);
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/** A section's paragraphs, Exa's fact tables left out; null when nothing is left. */
function prose(lines: string[]): string | null {
  const text = lines
    .filter((l) => !l.startsWith("|"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

/** `### [School](url)` or `### Degree - [School](url)`, then a dates line when there is one. */
function schoolsOf(lines: string[]): School[] {
  const out: School[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (!l.startsWith("### ")) continue;
    const entry = l.slice(4).trim();
    const at = entry.lastIndexOf(" - ");
    const { company, companyUrl } = companyOf(at > 0 ? entry.slice(at + 3) : entry);
    const next = lines.slice(i + 1).find(Boolean) ?? "";
    out.push({
      school: company,
      schoolUrl: companyUrl,
      degree: at > 0 ? entry.slice(0, at).trim() : null,
      dates: RANGE_LINE.test(next) ? next : null,
    });
  }
  return out;
}

/**
 * People whose public profiles match `query` ("recruiters who work or worked
 * at Acme"): Exa's people index, each with every role it lists. Exa only; no
 * other backend reads profiles.
 */
export async function people(query: string, deps: Deps, o: { n?: number } = {}): Promise<People> {
  const body = (await exaJson(deps, "/search", {
    query,
    category: "people",
    numResults: o.n ?? 10,
    type: "auto",
    contents: { text: { maxCharacters: 8000 } },
  })) as { results?: Array<{ url: string; text?: string }> };
  const out: Person[] = [];
  for (const r of body.results ?? []) {
    const p = r.text ? exaProfile(r.text) : null;
    if (p) out.push({ ...p, url: r.url });
  }
  return { query, people: out, via: "exa", raw: body.results ?? [] };
}

/* ---------------- LinkedIn pages, from Exa's cache ---------------- */

const LI = "https://www.linkedin.com";

/** A role as the `linkedin` site's profile route returns it; `companyUrl` absent when the profile links none. */
export interface CachedRole {
  title: string;
  company: string;
  companyUrl?: string;
  /** "Jan 2025 - Present", as LinkedIn writes it. */
  dates?: string;
  location?: string;
  current: boolean;
}

export interface CachedSchool {
  school: string;
  schoolUrl?: string;
  degree?: string;
  dates?: string;
  location?: string;
}

/** `linkedin GET /in/{vanity}`'s shape, read from Exa's copy of the page. */
export interface CachedProfile {
  name: string;
  vanity: string;
  url: string;
  headline?: string;
  location?: string;
  connections?: string;
  about?: string;
  roles: CachedRole[];
  education: CachedSchool[];
  /** Exa's whole page, as it wrote it. */
  text: string;
  source: string;
}

/** A company as Exa writes it: `linkedin GET /company/{company}`'s fields, and the rest Exa adds. */
export interface CompanyFacts {
  name: string;
  /** `https://acme.com`: Exa's Homepage, with a scheme. */
  website?: string;
  phone?: string;
  industry?: string;
  /** "11-50 employees". */
  size?: string;
  headquarters?: string;
  founded?: string;
  /** Privately held, Public company, …. */
  type?: string;
  employees?: number;
  about?: string;
  /** The company's LinkedIn handle, when Exa links it. */
  handle?: string;
}

/** `linkedin GET /company/{company}`'s shape, read from Exa's copy of the page. */
export interface CachedCompany extends CompanyFacts {
  handle: string;
  url: string;
  text: string;
  source: string;
}

/** A page's first segment after `/in/` or `/company/`, any LinkedIn host, query and slashes dropped. */
export function linkedinSlug(raw: string, kind: "in" | "company"): string {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new WebMiss(`not a URL: want a linkedin.com/${kind}/ page`, 400);
  }
  const host = u.hostname.toLowerCase();
  const [first, slug] = u.pathname.split("/").filter(Boolean);
  if (!(host === "linkedin.com" || host.endsWith(".linkedin.com")) || first !== kind || !slug)
    throw new WebMiss(`not a linkedin.com/${kind}/ page`, 400);
  return decodeURIComponent(slug);
}

/** "Jan 2025 - Present (1 year) in Denver": the range LinkedIn would print, and the place. */
function rangeOf(line: string | null): { dates?: string; location?: string } {
  if (!line) return {};
  const range = /^((?:[A-Z][a-z]{2} )?\d{4}(?: - (?:Present|(?:[A-Z][a-z]{2} )?\d{4}))?)/.exec(
    line,
  );
  const place = / in (.+)$/.exec(line);
  return {
    ...(range?.[1] ? { dates: range[1] } : {}),
    ...(place?.[1] ? { location: place[1].trim() } : {}),
  };
}

const some = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined && v !== "";

/** Exa's profile text as the `linkedin` site's profile; null when it is not a profile. */
export function cachedProfile(text: string, vanity: string, source: string): CachedProfile | null {
  const p = exaProfile(text);
  if (!p) return null;
  return {
    name: p.name,
    vanity,
    url: `${LI}/in/${vanity}/`,
    ...(some(p.headline) ? { headline: p.headline } : {}),
    // "Denver, Colorado, United States (US)": LinkedIn prints no country code.
    ...(some(p.location) ? { location: p.location.replace(/\s*\([A-Z]{2}\)$/, "") } : {}),
    ...(some(p.connections) ? { connections: p.connections } : {}),
    ...(some(p.about) ? { about: p.about } : {}),
    roles: p.roles.map((r) => ({
      title: r.title,
      company: r.company,
      ...(r.companyUrl ? { companyUrl: r.companyUrl } : {}),
      ...rangeOf(r.dates),
      current: r.current,
    })),
    education: p.education.map((e) => ({
      school: e.school,
      ...(e.schoolUrl ? { schoolUrl: e.schoolUrl } : {}),
      ...(e.degree ? { degree: e.degree } : {}),
      ...rangeOf(e.dates),
    })),
    text,
    source,
  };
}

const COUNT = (s: string | undefined) => {
  const n = s ? Number(s.replace(/,/g, "")) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
};

/**
 * A company page as Exa writes it: `# Name`, an intro ("… employs 12 people …"),
 * `## About`, `## Company Details` as `- Key: Value` lines (Industry, Type,
 * Headquarters, Founded Year, Homepage, LinkedIn, Phone) and `## Workforce`
 * (Employees, Company Size). Null when there is no name.
 */
export function exaCompany(text: string): CompanyFacts | null {
  const lines = text.split("\n").map((l) => l.trim());
  const name = lines
    .find((l) => l.startsWith("# "))
    ?.slice(2)
    .trim();
  if (!name) return null;
  const facts = new Map<string, string>();
  for (const l of [...section(lines, "Company Details"), ...section(lines, "Workforce")]) {
    const m = /^- ([A-Za-z ]+): (.+)$/.exec(l);
    if (m?.[1] && m[2] && !facts.has(m[1])) facts.set(m[1], m[2].trim());
  }
  const homepage = facts.get("Homepage");
  const li = facts.get("LinkedIn");
  const employees =
    COUNT(facts.get("Employees")) ?? COUNT(/ employs ([\d,]+) people/.exec(text)?.[1]);
  const about = prose(section(lines, "About"));
  const out: CompanyFacts = { name };
  const set = <K extends keyof CompanyFacts>(k: K, v: CompanyFacts[K] | undefined) => {
    if (some(v)) out[k] = v;
  };
  set(
    "website",
    homepage ? (/^https?:\/\//i.test(homepage) ? homepage : `https://${homepage}`) : undefined,
  );
  set("phone", facts.get("Phone"));
  set("industry", facts.get("Industry"));
  set("size", facts.get("Company Size"));
  set("headquarters", facts.get("Headquarters"));
  set("founded", facts.get("Founded Year"));
  set("type", facts.get("Type"));
  set("employees", employees);
  set("about", about ?? undefined);
  if (li) {
    try {
      set("handle", linkedinSlug(li, "company"));
    } catch {
      // A LinkedIn line that is not a company page names no handle.
    }
  }
  return out;
}

/** Characters of a cached page kept: a big company's page runs past 20k, every field sits in the first part. */
const PAGE_CHARS = 20_000;

/**
 * One LinkedIn page from Exa's cache, never fetched live (`livecrawl: never`):
 * neither LinkedIn nor Exa's crawler visits it for this call. A page Exa does
 * not hold is a 404 (Exa charges nothing for it). The URL stays out of every
 * message: it names a person.
 */
async function cachedPage(url: string, deps: Deps): Promise<{ text: string; source: string }> {
  const body = (await exaJson(deps, "/contents", {
    urls: [url],
    livecrawl: "never",
    text: { maxCharacters: PAGE_CHARS },
  })) as {
    results?: Array<{ text?: string }>;
    statuses?: Array<{
      status?: string;
      source?: string;
      error?: { httpStatusCode?: number; tag?: string };
    }>;
  };
  const status = body.statuses?.[0];
  if (status?.status === "error") {
    if (status.error?.httpStatusCode === 404)
      throw new WebMiss("exa holds no copy of that page (ENTITY_NOT_FOUND)", 404);
    throw new WebMiss(`exa could not give that page: ${status.error?.tag ?? "error"}`, 502);
  }
  const text = body.results?.[0]?.text?.trim();
  if (!text) throw new WebMiss("exa gave that page with no text", 502);
  return { text, source: status?.source ?? "cached" };
}

/** A LinkedIn profile from Exa's cache, in the `linkedin` site's profile shape plus `education` and `text`. */
export async function cachedLinkedinProfile(url: string, deps: Deps): Promise<CachedProfile> {
  const vanity = linkedinSlug(url, "in");
  const { text, source } = await cachedPage(`${LI}/in/${vanity}`, deps);
  const p = cachedProfile(text, vanity, source);
  if (!p) throw new WebMiss("exa's copy of that page is not a profile", 502);
  return p;
}

/** A LinkedIn company page from Exa's cache, in the `linkedin` site's company shape plus `type`, `employees`, `about` and `text`. */
export async function cachedLinkedinCompany(url: string, deps: Deps): Promise<CachedCompany> {
  const slug = linkedinSlug(url, "company");
  const { text, source } = await cachedPage(`${LI}/company/${slug}`, deps);
  const c = exaCompany(text);
  if (!c) throw new WebMiss("exa's copy of that page is not a company", 502);
  const handle = c.handle ?? slug;
  return { ...c, handle, url: `${LI}/company/${handle}/`, text, source };
}

/** One company Exa's company search found. */
export interface FoundCompany extends CompanyFacts {
  /** `https://www.linkedin.com/company/<handle>/`, when Exa links one. */
  linkedin: string | null;
  /** The page Exa found it at (its homepage, or a LinkedIn page). */
  url: string;
  /** Its homepage is the domain asked about (`www.` aside). Look-alike firms share names. */
  homepageMatches: boolean;
}

export interface Companies {
  domain: string;
  companies: FoundCompany[];
  via: string;
  /** Every result Exa sent, text and all, the ones that didn't parse as a company too. */
  raw: unknown[];
}

/** `https://www.Acme.com/about` → `acme.com`. */
export const hostOf = (raw: string): string => {
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** Companies Exa's company index has for `domain`, each with its LinkedIn page when Exa links one. */
export async function companies(
  domain: string,
  deps: Deps,
  o: { n?: number } = {},
): Promise<Companies> {
  const want = hostOf(domain);
  if (!want.includes(".")) throw new WebMiss("domain: want a bare domain like acme.com", 400);
  const body = (await exaJson(deps, "/search", {
    query: want,
    category: "company",
    numResults: o.n ?? 3,
    type: "auto",
    contents: { text: { maxCharacters: 8000 } },
  })) as { results?: Array<{ url: string; text?: string }> };
  const out: FoundCompany[] = [];
  for (const r of body.results ?? []) {
    const c = r.text ? exaCompany(r.text) : null;
    if (!c) continue;
    out.push({
      ...c,
      linkedin: c.handle ? `${LI}/company/${c.handle}/` : null,
      url: r.url,
      homepageMatches: c.website ? hostOf(c.website) === want : false,
    });
  }
  return { domain: want, companies: out, via: "exa", raw: body.results ?? [] };
}
