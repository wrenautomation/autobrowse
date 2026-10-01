/**
 * LinkedIn as a lead source and an outreach channel, through a logged-in
 * browser: the idea behind linkedin-mcp-server (Agent-Reach), on our own
 * browser legs. LinkedIn's API has no people search or invites for anyone
 * but partners, so these are browser flows only.
 *
 * Mapped 2026-09-25 in explore as linkedin@wren. Every class is a build
 * hash, so rows are found by shape: a list item holding an `/in/` link, its
 * innerText read line by line. Search rows read name (with "• 3rd+"),
 * headline, location, an action, then "Current: …" or "Past: …". The
 * invite dialog lives at `/preload/custom-invite/?vanityName=`: "Add a
 * note" or "Send without a note", then `textarea#custom-message` and "Send
 * invitation". A free account has five notes a month, 200 characters each.
 * Messaging is free only to a 1st-degree connection; anyone else gets the
 * InMail upsell, so `message` was written from LinkedIn's aria labels and
 * is unproven until Wren has a connection.
 *
 * Reads run as whichever LinkedIn profile the facade picks (Wren's, by the
 * accounts policy). Connect and message are irreversible: the routes say
 * so and the act is never repaired.
 */
import { defineFlow, type FlowPage } from "../flow.js";
import type { Hints } from "../locate.js";

/** The little of the DOM these page scripts touch; the project compiles without lib dom. */
interface El {
  innerText: string;
  href: string;
  className: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
  nextElementSibling: El | null;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): Iterable<El>;
}
declare const document: El;
declare const location: { href: string };

const WEB = "https://www.linkedin.com";
const RENDER_MS = 15_000;
const SETTLE_MS = 1_500;
/** A lead a row names; `vanity` is the `/in/<vanity>/` handle every other call takes. */
export interface Person {
  name: string;
  vanity: string;
  url: string;
  degree?: string;
  headline?: string;
  location?: string;
  /** "Current: …" or "Past: …" as the row says it: the role that matched the search. */
  current?: string;
  past?: string;
}

/** What a row is on the page: its text, and the profile links inside it. */
export interface RawRow {
  text: string;
  links: string[];
}

export const vanityOf = (url: string): string | null => {
  const m = /\/in\/([^/?#]+)/.exec(url);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
};

const DEGREE = /[•·]\s*(1st|2nd|3rd\+?)/;
const LONE_DEGREE = /^(1st|2nd|3rd\+?)( degree connection)?$/i;
/** A line that is only a bullet or a dot between two facts. */
const SEPARATOR = /^[•·|,\-–]+$/;
const PRONOUNS = /^(he\/him|she\/her|they\/them)$/i;
/** Lines that are controls or social proof, never facts about the person. */
const NOISE =
  /^(connect|message|follow|following|pending|view .*profile|status is .*|.*mutual connections?|.*followers|provides services.*|view my services|premium|open to work)$/i;

/** One search or company row as a person; null for "LinkedIn Member" rows with no profile. */
export function personOf(row: RawRow): Person | null {
  const url = row.links.map((l) => l.split("?")[0] ?? l).find((l) => vanityOf(l));
  const vanity = url ? vanityOf(url) : null;
  if (!url || !vanity) return null;
  const lines = row.text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !NOISE.test(l));
  let degree: string | undefined;
  const facts: string[] = [];
  const out: Person = { name: "", vanity, url: `${WEB}/in/${vanity}/` };
  for (const line of lines) {
    const d = DEGREE.exec(line);
    if (d) degree ??= d[1];
    const rest = line.replace(DEGREE, "").trim();
    // "Name • 3rd+" and a lone "• 3rd+" on the next line are both the name's.
    const lone = LONE_DEGREE.exec(rest);
    if (lone) degree ??= lone[1];
    if (!rest || lone || SEPARATOR.test(rest)) continue;
    const cur = /^current:\s*(.+)$/i.exec(rest);
    const past = /^past:\s*(.+)$/i.exec(rest);
    if (cur?.[1]) out.current = cur[1];
    else if (past?.[1]) out.past = past[1];
    else if (!facts.includes(rest)) facts.push(rest);
  }
  const [name, headline, location] = facts;
  if (!name || /^linkedin member$/i.test(name)) return null;
  out.name = name;
  if (degree) out.degree = degree;
  if (headline) out.headline = headline;
  if (location) out.location = location;
  return out;
}

/** People in the rows, each once. */
export function peopleOf(rows: RawRow[]): Person[] {
  const seen = new Set<string>();
  const out: Person[] = [];
  for (const r of rows) {
    const p = personOf(r);
    if (p && !seen.has(p.vanity)) {
      seen.add(p.vanity);
      out.push(p);
    }
  }
  return out;
}

/** Every list item with a profile link: search results and company people alike. */
const rowsOnPage = (fp: FlowPage): Promise<RawRow[]> =>
  fp.page.evaluate(() => {
    const items = [...document.querySelectorAll("main [role=listitem], main li")];
    // A card nested in another card counts once: the innermost item with the link.
    return items
      .filter((li) => !li.querySelector("[role=listitem], li"))
      .map((li) => ({
        text: li.innerText,
        links: [...li.querySelectorAll("a[href*='/in/']")].map((a) => a.href),
      }))
      .filter((r) => r.links.length);
  });

/**
 * LinkedIn's "Allow pages to see that you visited" modal covers every page
 * until answered, so a click under it times out. The private answer.
 */
const dontAllow: Hints = { role: "button", name: "/^don.t allow$/i" };

async function go(fp: FlowPage, url: string): Promise<void> {
  await fp.open(url);
  if (await fp.has(dontAllow, 2_000))
    await fp.act({ kind: "click" }, dontAllow, { goal: "keep page visits private" });
}

const LIMITED = /reached the (monthly )?(commercial use )?limit|commercial use limit/i;
const EMPTY = /no results found|no matching members/i;

async function waitRows(fp: FlowPage): Promise<RawRow[]> {
  for (let i = 0; i < RENDER_MS / SETTLE_MS; i++) {
    const rows = await rowsOnPage(fp);
    if (rows.length) return rows;
    const text = await fp.text();
    if (LIMITED.test(text)) return fp.human("LinkedIn's free search limit for the month is hit");
    if (EMPTY.test(text)) return [];
    await fp.wait(SETTLE_MS);
  }
  return [];
}

export interface SearchPeopleInput {
  keywords: string;
  /** First results page, 1-based. */
  page?: number;
  /** How many pages from there (10 people a page). */
  pages?: number;
  /** Connection degree: F = 1st, S = 2nd, O = 3rd+. */
  network?: Array<"F" | "S" | "O">;
}

export const searchUrl = (i: SearchPeopleInput, page: number): string => {
  const u = new URL(`${WEB}/search/results/people/`);
  u.searchParams.set("keywords", i.keywords);
  if (i.network?.length) u.searchParams.set("network", JSON.stringify(i.network));
  if (page > 1) u.searchParams.set("page", String(page));
  return u.toString();
};

export const linkedinSearchPeople = defineFlow<
  SearchPeopleInput,
  { people: Person[]; pages: number }
>({
  site: "linkedin",
  name: "search-people",
  async run(fp, input) {
    const first = input.page ?? 1;
    const people: Person[] = [];
    let read = 0;
    for (let p = first; p < first + (input.pages ?? 1); p++) {
      await go(fp, searchUrl(input, p));
      const found = peopleOf(await waitRows(fp));
      read++;
      const fresh = found.filter((x) => !people.some((y) => y.vanity === x.vanity));
      people.push(...fresh);
      // A short page, or one that only repeats, is the last one.
      if (found.length < 10 || !fresh.length) break;
      await fp.wait(SETTLE_MS * 2);
    }
    return { people, pages: read };
  },
});

export interface ProfileInput {
  vanity: string;
  /** Also read the experience page: every role, structured. */
  experience?: boolean;
  /** Also read the current employer's page (website, size, industry); implies experience. */
  company?: boolean;
  /** Text naming the role that matters (a search row's "Current: …"): picks among current roles. */
  prefer?: string;
}

/** One role off the experience page. */
export interface Role {
  title: string;
  company: string;
  /** `https://www.linkedin.com/company/<id>/`: the handle the company route takes. */
  companyUrl: string;
  /** "Apr 2023 - Present", as LinkedIn writes it. */
  dates?: string;
  location?: string;
  current: boolean;
}

/** A company's About page. */
export interface Company {
  name: string;
  /** The `/company/<handle>/` it lives at (a numeric id redirects to it). */
  handle: string;
  url: string;
  website?: string;
  phone?: string;
  industry?: string;
  size?: string;
  headquarters?: string;
  founded?: string;
}

export interface Profile {
  name: string;
  vanity: string;
  url: string;
  degree?: string;
  headline?: string;
  location?: string;
  connections?: string;
  about?: string;
  roles?: Role[];
  /** The current role's company, read from its own page. */
  company?: Company;
}

/** The top card's lines as a profile: name, headline, location sit above "Contact info". */
export function profileOf(vanity: string, top: string, about: string | null): Profile {
  const lines = top
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const out: Profile = { name: "", vanity, url: `${WEB}/in/${vanity}/` };
  const facts: string[] = [];
  for (const line of lines) {
    if (/^contact info$/i.test(line)) break;
    const d = DEGREE.exec(line);
    if (d?.[1]) out.degree ??= d[1];
    const rest = line.replace(DEGREE, "").trim();
    const lone = LONE_DEGREE.exec(rest);
    if (lone?.[1]) out.degree ??= lone[1];
    if (!rest || lone || SEPARATOR.test(rest) || PRONOUNS.test(rest) || /verified/i.test(rest))
      continue;
    facts.push(rest);
  }
  const [name, headline, ...rest] = facts;
  out.name = name ?? "";
  if (headline) out.headline = headline;
  const location = rest.at(-1);
  if (location) out.location = location;
  const conns = /([\d,]+\+?)\s+connections/i.exec(top);
  if (conns?.[1]) out.connections = conns[1];
  const a = about
    ?.replace(/^about\s*/i, "")
    .replace(/…\s*(see )?more$/i, "")
    .trim();
  if (a) out.about = a;
  return out;
}

/** An experience entry: its lines and the company it links to. */
export interface RoleAnchor {
  lines: string[];
  href: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Nov 2024 - Present · 1 yr 11 mos", "2019 - 2021". */
const RANGE = /^((?:[A-Z][a-z]{2} )?\d{4})\s+-\s+(Present|(?:[A-Z][a-z]{2} )?\d{4})/;
const DURATION_ONLY = /^(\d+ yrs?( \d+ mos?)?|\d+ mos?|less than a year)$/i;

/**
 * Experience entries as roles. One company's several roles come as a header
 * entry (company, total time) followed by entries that link the same company
 * and carry only title, type, dates. A role ending this month reads current:
 * LinkedIn writes an ongoing role's end as the month it renders.
 */
export function rolesOf(anchors: RoleAnchor[], now = new Date()): Role[] {
  const thisMonth = `${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
  const grouped = new Map<string, string>();
  const roles: Role[] = [];
  for (const { lines, href } of anchors) {
    const companyUrl = href.split("?")[0] ?? href;
    const [first, second] = lines;
    if (!first) continue;
    if (lines.length <= 2 && second && DURATION_ONLY.test(second)) {
      grouped.set(companyUrl, first);
      continue;
    }
    const dates = lines.find((l) => RANGE.test(l));
    const range = dates ? RANGE.exec(dates) : null;
    const company = grouped.get(companyUrl) ?? second?.split(" · ")[0] ?? "";
    if (!company || RANGE.test(company)) continue;
    const role: Role = {
      title: first,
      company,
      companyUrl,
      current: Boolean(range && (range[2] === "Present" || range[2] === thisMonth)),
    };
    if (dates) role.dates = dates.split(" · ")[0] ?? dates;
    const at = dates ? lines.indexOf(dates) : -1;
    const location = at >= 0 ? lines[at + 1]?.split(" · ")[0] : undefined;
    if (location && !DURATION_ONLY.test(location)) role.location = location;
    if (!roles.some((r) => r.title === role.title && r.companyUrl === role.companyUrl))
      roles.push(role);
  }
  return roles;
}

/** The About page's term/value pairs as a company. */
export function companyOf(
  url: string,
  name: string,
  fields: Record<string, string>,
): Company | null {
  const handle = /\/company\/([^/?#]+)/.exec(url)?.[1];
  if (!handle || !name) return null;
  const first = (k: string) => fields[k]?.split("\n")[0]?.trim() || undefined;
  const out: Company = { name: name.trim(), handle, url: `${WEB}/company/${handle}/` };
  const pairs: Array<[keyof Company, string]> = [
    ["website", "Website"],
    ["phone", "Phone"],
    ["industry", "Industry"],
    ["size", "Company size"],
    ["headquarters", "Headquarters"],
    ["founded", "Founded"],
  ];
  for (const [k, label] of pairs) {
    const v = first(label);
    if (v) out[k] = v;
  }
  return out;
}

/**
 * The role a lead is about: a current one whose company the hints name (the
 * search row's matched role, the headline), else the first current one,
 * else the latest. A hospitalist who founded a clinic is the clinic's founder.
 */
export function pickRole(roles: Role[], hints: Array<string | undefined>): Role | undefined {
  const current = roles.filter((r) => r.current);
  const pool = current.length ? current : roles;
  const said = hints.filter(Boolean).map((h) => (h as string).toLowerCase());
  return pool.find((r) => said.some((h) => h.includes(r.company.toLowerCase()))) ?? pool[0];
}

const ABOUT_LABELS = new Set([
  "Website",
  "Phone",
  "Industry",
  "Company size",
  "Headquarters",
  "Founded",
  "Type",
  "Specialties",
]);

/**
 * The About page's labels and values from its text. Since 2026-09-29 the
 * page has no `dt`/`dd`: under "Overview" each label is a line and its value
 * the next ("Company size", "5,001-10,000 employees").
 */
export function aboutFieldsOf(text: string): Record<string, string> {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const out: Record<string, string> = {};
  for (let i = Math.max(0, lines.indexOf("Overview")); i < lines.length - 1; i++) {
    const label = lines[i] as string;
    if (ABOUT_LABELS.has(label) && !(label in out)) out[label] = lines[i + 1] as string;
  }
  return out;
}

/** The company's name heading: `h1` on the old page, the first `h2` on the new. */
const NAME = "main h1, main h2";

async function readCompany(fp: FlowPage, handle: string): Promise<Company | null> {
  const id = /\/company\/([^/?#]+)/.exec(handle)?.[1] ?? handle;
  await go(fp, `${WEB}/company/${encodeURIComponent(id)}/about/`);
  if (!(await fp.has({ css: NAME }, RENDER_MS))) return null;
  await fp.wait(SETTLE_MS);
  const { url, name, text, fields } = await fp.page.evaluate((sel) => {
    const fields: Record<string, string> = {};
    for (const dt of document.querySelectorAll("main dt")) {
      const dd = dt.nextElementSibling;
      if (dd) fields[dt.innerText.trim()] = dd.innerText.trim();
    }
    return {
      url: location.href,
      name: document.querySelector(sel)?.innerText ?? "",
      text: document.querySelector("main")?.innerText ?? "",
      fields,
    };
  }, NAME);
  return companyOf(url, name, { ...aboutFieldsOf(text), ...fields });
}

export const linkedinProfile = defineFlow<ProfileInput, Profile>({
  site: "linkedin",
  name: "profile",
  async run(fp, input) {
    await go(fp, `${WEB}/in/${encodeURIComponent(input.vanity)}/`);
    if (!(await fp.has({ css: "main section" }, RENDER_MS)))
      return fp.human(`no profile at ${fp.url()}`);
    const { top, about } = await fp.page.evaluate(() => {
      const sections = [...document.querySelectorAll("main section")];
      return {
        top: sections[0]?.innerText ?? "",
        about: sections.find((s) => /^\s*about\b/i.test(s.innerText))?.innerText ?? null,
      };
    });
    const out = profileOf(input.vanity, top, about);
    if (!out.name) return fp.human(`the profile at ${fp.url()} read no name`);
    if (input.experience || input.company) {
      await go(fp, `${WEB}/in/${encodeURIComponent(input.vanity)}/details/experience/`);
      if (await fp.has({ css: "main a[href*='/company/']" }, RENDER_MS)) {
        await fp.wait(SETTLE_MS);
        const anchors = await fp.page.evaluate(() =>
          [...document.querySelectorAll("main a[href*='/company/']")]
            .map((a) => ({
              lines: a.innerText
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean),
              href: a.href,
            }))
            .filter((a) => a.lines.length),
        );
        out.roles = rolesOf(anchors);
      }
    }
    const current = out.roles && pickRole(out.roles, [input.prefer, out.headline]);
    if (input.company && current) {
      const company = await readCompany(fp, current.companyUrl);
      if (company) out.company = company;
    }
    return out;
  },
});

export const linkedinCompany = defineFlow<{ company: string }, Company>({
  site: "linkedin",
  name: "company",
  async run(fp, input) {
    const company = await readCompany(fp, input.company);
    return company ?? fp.human(`no company page for ${input.company} (${fp.url()})`);
  },
});

export interface CompanyPeopleInput {
  /** The `/company/<slug>/` handle. */
  company: string;
  /** Narrows to titles or names: "founder", "partner". */
  keywords?: string;
  max?: number;
}

const showMore: Hints = { role: "button", name: "/show more results/i" };

export const linkedinCompanyPeople = defineFlow<CompanyPeopleInput, { people: Person[] }>({
  site: "linkedin",
  name: "company-people",
  async run(fp, input) {
    const u = new URL(`${WEB}/company/${encodeURIComponent(input.company)}/people/`);
    if (input.keywords) u.searchParams.set("keywords", input.keywords);
    await go(fp, u.toString());
    const max = input.max ?? 30;
    let people = peopleOf(await waitRows(fp));
    // The page shows a dozen and grows by "Show more results".
    for (let i = 0; i < 20 && people.length < max && (await fp.has(showMore, 3_000)); i++) {
      const before = people.length;
      await fp.act({ kind: "click" }, showMore, { goal: "load more people" });
      for (let t = 0; t < 6 && people.length === before; t++) {
        await fp.wait(SETTLE_MS);
        people = peopleOf(await rowsOnPage(fp));
      }
      if (people.length === before) break;
    }
    return { people: people.slice(0, max) };
  },
});

export interface CompanyJobsInput {
  /** The `/company/<slug>/` handle, or LinkedIn's numeric company id. */
  company: string;
  max?: number;
  /** Where the roles are: "Worldwide" (the default), "United States", "Toronto". */
  location?: string;
}

/** An open role: a hiring signal. `postedAt` is the date LinkedIn lists it (YYYY-MM-DD). */
export interface Job {
  id: string;
  title: string;
  url: string;
  company?: string;
  location?: string;
  postedAt?: string;
}

/** A job card's fields as the page gives them. */
export interface RawJob {
  urn: string;
  title: string;
  company: string;
  location: string;
  datetime: string;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const decode = (s: string) =>
  s
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
      e[0] === "#"
        ? String.fromCodePoint(
            e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)),
          )
        : (ENTITIES[e.toLowerCase()] ?? m),
    );

/** The text inside the first element whose class list holds `cls`. */
const inner = (html: string, cls: string) =>
  decode(
    new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</(h3|h4|span|a)>`).exec(
      html,
    )?.[1] ?? "",
  );

/** The public jobs list's cards (`<li>` each) as the page gives them. */
export function jobCardsOf(html: string): RawJob[] {
  return html
    .split(/<li[\s>]/)
    .filter((c) => c.includes("jobPosting:"))
    .map((c) => ({
      urn: /data-entity-urn="([^"]+)"/.exec(c)?.[1] ?? "",
      title: inner(c, "base-search-card__title"),
      company: inner(c, "base-search-card__subtitle"),
      location: inner(c, "job-search-card__location"),
      datetime: /<time[^>]*datetime="([^"]+)"/.exec(c)?.[1] ?? "",
    }));
}

/** Job cards as jobs, once each, in the order listed. */
export function jobsOf(raws: RawJob[]): Job[] {
  const out: Job[] = [];
  const seen = new Set<string>();
  for (const r of raws) {
    const id = /jobPosting:(\d+)/.exec(r.urn)?.[1];
    const title = squash(r.title);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const job: Job = { id, title, url: `${WEB}/jobs/view/${id}/` };
    if (squash(r.company)) job.company = squash(r.company);
    if (squash(r.location)) job.location = squash(r.location);
    if (/^\d{4}-\d{2}-\d{2}$/.test(r.datetime)) job.postedAt = r.datetime;
    out.push(job);
  }
  return out;
}

/**
 * The numeric id a company page links by: its jobs link carries `f_C=<id>`,
 * its employees link `currentCompany=["<id>"]`.
 */
export function companyIdOf(url: string, hrefs: string[]): string | null {
  for (const h of [url, ...hrefs]) {
    const m = /[?&]f_C=(\d+)/.exec(h) ?? /currentCompany=(?:%5B%22|\[")(\d+)/.exec(h);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** LinkedIn's public jobs list: ten cards a page, paged by `start`. */
const JOBS_PAGE = 10;
const jobsPath = (id: string, start: number, location: string) =>
  `/jobs-guest/jobs/api/seeMoreJobPostings/search?f_C=${id}&location=${encodeURIComponent(location)}&start=${start}`;

/**
 * A company's open roles. Mapped 2026-09-29: the logged-in jobs UI (and the
 * public list with the session's cookies) is geo-filtered to the account's
 * city, so this reads the public list without cookies from inside the page,
 * a page at a time, and with them only when the public list is throttled. The page's Trusted Types refuse DOMParser, so the cards
 * come back as HTML and are read here.
 */
export const linkedinCompanyJobs = defineFlow<CompanyJobsInput, { companyId: string; jobs: Job[] }>(
  {
    site: "linkedin",
    name: "company-jobs",
    async run(fp, input) {
      const max = input.max ?? 50;
      const handle = /\/company\/([^/?#]+)/.exec(input.company)?.[1] ?? input.company;
      await go(fp, `${WEB}/company/${encodeURIComponent(handle)}/about/`);
      let id = /^\d+$/.test(handle) ? handle : null;
      if (!id && (await fp.has({ css: "a[href*='currentCompany'], a[href*='f_C=']" }, RENDER_MS))) {
        const { url, hrefs } = await fp.page.evaluate(() => ({
          url: location.href,
          hrefs: [...document.querySelectorAll("a[href]")].map((a) => a.href),
        }));
        id = companyIdOf(url, hrefs);
      }
      if (!id) return fp.human(`no company id for ${input.company} (${fp.url()})`);
      const raws: RawJob[] = [];
      let jobs: Job[] = [];
      for (let start = 0; jobs.length < max && start < 1000; start += JOBS_PAGE) {
        if (start) await fp.wait(SETTLE_MS);
        const page = await fp.page.evaluate(
          async (path) => {
            // Signed out first (not geo-filtered); signed in when the public list is throttled.
            let res = await fetch(path, { credentials: "omit" });
            if (!res.ok) res = await fetch(path, { credentials: "include" });
            return { status: res.status, html: res.ok ? await res.text() : "" };
          },
          jobsPath(id, start, input.location ?? "Worldwide"),
        );
        if (page.status !== 200 && !jobs.length)
          return fp.human(`LinkedIn's jobs list answered ${page.status} for company ${id}`);
        const cards = jobCardsOf(page.html);
        if (!cards.length) break;
        raws.push(...cards);
        jobs = jobsOf(raws);
      }
      return { companyId: id, jobs: jobs.slice(0, max) };
    },
  },
);

export interface ConnectInput {
  vanity: string;
  /** Up to 200 characters; a free account has five notes a month. */
  note?: string;
}

const addNote: Hints = { role: "button", name: "/^add a note$/i" };
const sendBare: Hints = { role: "button", name: "/^send without a note$/i" };
const noteBox: Hints = { css: "textarea#custom-message, textarea[name=message]" };
const sendInvite: Hints = { role: "button", name: "/^send( invitation)?$/i" };
const NOTES_LEFT = /(\d+)\s+personalized invitations? remaining/i;
const NO_NOTES = /no personalized invitations|out of personalized|0 personalized invitations/i;

export const linkedinConnect = defineFlow<
  ConnectInput,
  { sent: true; note: boolean; notesLeft?: number }
>({
  site: "linkedin",
  name: "connect",
  async run(fp, input) {
    await go(fp, `${WEB}/preload/custom-invite/?vanityName=${encodeURIComponent(input.vanity)}`);
    if (!(await fp.has(sendBare, RENDER_MS)) && !(await fp.has(addNote, 1_000)))
      return fp.human(
        `no invite dialog for ${input.vanity}: already connected, invite pending, or Follow only`,
      );
    let notesLeft: number | undefined;
    if (input.note) {
      await fp.act({ kind: "click" }, addNote, { goal: "add a note" });
      if (!(await fp.has(noteBox, RENDER_MS))) {
        const text = await fp.text();
        return fp.human(
          NO_NOTES.test(text)
            ? "no personalized invitations left this month; send without a note or wait"
            : "the note box did not open",
        );
      }
      const left = NOTES_LEFT.exec(await fp.text())?.[1];
      if (left !== undefined) notesLeft = Math.max(0, Number(left) - 1);
      await fp.act({ kind: "fill", value: input.note }, noteBox, { goal: "type the note" });
      await fp.wait(SETTLE_MS);
      await fp.act({ kind: "click" }, sendInvite, {
        goal: `send the invitation to ${input.vanity}`,
        irreversible: true,
      });
    } else {
      await fp.act({ kind: "click" }, sendBare, {
        goal: `send the invitation to ${input.vanity}`,
        irreversible: true,
      });
    }
    await fp.wait(SETTLE_MS);
    const text = await fp.text();
    if (/weekly invitation limit|too many invitations|couldn.t send|try again/i.test(text))
      return fp.human(`LinkedIn did not take the invitation: ${text.slice(0, 200)}`);
    return {
      sent: true,
      note: Boolean(input.note),
      ...(notesLeft !== undefined ? { notesLeft } : {}),
    };
  },
});

export interface MessageInput {
  vanity: string;
  text: string;
}

const messageBox: Hints = { css: "div[role=textbox][contenteditable=true]" };
const sendMessage: Hints = { role: "button", name: "/^send$/i" };

export const linkedinMessage = defineFlow<MessageInput, { sent: true }>({
  site: "linkedin",
  name: "message",
  async run(fp, input) {
    await go(fp, `${WEB}/in/${encodeURIComponent(input.vanity)}/`);
    if (!(await fp.has({ css: "main section" }, RENDER_MS)))
      return fp.human(`no profile at ${fp.url()}`);
    // The Message link carries the member id; the compose page takes it whole.
    const compose = await fp.page.evaluate(
      () => document.querySelector("main a[href*='/messaging/compose/']")?.href ?? null,
    );
    if (!compose) return fp.human(`${input.vanity} has no Message button for this account`);
    await go(fp, compose);
    if (!(await fp.has(messageBox, RENDER_MS)))
      return fp.human(
        `no free message box for ${input.vanity}: not a 1st-degree connection (InMail needs Premium)`,
      );
    await fp.act({ kind: "fill", value: input.text }, messageBox, { goal: "type the message" });
    await fp.wait(SETTLE_MS);
    await fp.act({ kind: "click" }, sendMessage, {
      goal: `send the message to ${input.vanity}`,
      irreversible: true,
    });
    await fp.wait(SETTLE_MS * 2);
    if (/couldn.t send|failed to send|try again/i.test(await fp.text()))
      return fp.human("LinkedIn did not send the message");
    return { sent: true };
  },
});

export interface RelationshipInput {
  vanity: string;
}

export type Relationship = "connected" | "pending" | "none" | "unknown";

const PENDING = /^pending$/i;
const CONNECT = /^connect$/i;
const MESSAGE = /^message$/i;

/**
 * Where this account stands with a member, from the buttons on the profile's
 * top card: "Message" with no "Connect" = 1st degree, "Pending" = our invite
 * is out, "Connect" = nothing yet. One profile read; the outreach loop asks
 * it before every follow-up message so a pending invite is never messaged
 * (that would be InMail) and an accepted one is caught without the inbox.
 */
export const linkedinRelationship = defineFlow<
  RelationshipInput,
  { vanity: string; relationship: Relationship; degree?: string }
>({
  site: "linkedin",
  name: "relationship",
  async run(fp, input) {
    await go(fp, `${WEB}/in/${encodeURIComponent(input.vanity)}/`);
    if (!(await fp.has({ css: "main section" }, RENDER_MS)))
      return fp.human(`no profile at ${fp.url()}`);
    await fp.wait(SETTLE_MS);
    const { buttons, degree } = await fp.page.evaluate(() => {
      const card = document.querySelector("main section");
      const labels = [...(card?.querySelectorAll("button, a[href]") ?? [])]
        .map((b) => (b.getAttribute("aria-label") || b.textContent || "").trim())
        .filter(Boolean);
      const text = card?.textContent ?? "";
      const d = /\b(1st|2nd|3rd\+?)\b/.exec(text)?.[1] ?? null;
      return { buttons: labels, degree: d };
    });
    const has = (re: RegExp) => buttons.some((b) => re.test(b) || re.test(b.split(/\s+/)[0] ?? ""));
    const relationship: Relationship = has(PENDING)
      ? "pending"
      : has(CONNECT)
        ? "none"
        : has(MESSAGE) || degree === "1st"
          ? "connected"
          : "unknown";
    return { vanity: input.vanity, relationship, ...(degree ? { degree } : {}) };
  },
});

export interface InboxInput {
  /** How many conversations from the top (default 20). */
  max?: number;
  /** Only conversations with unread messages. */
  unread?: boolean;
}

export interface Conversation {
  /** The conversation's own URL. */
  url: string;
  /** The other person's shown name. */
  name: string;
  /** Their profile handle when the row links it. */
  vanity?: string;
  /** The last message's text as the list previews it. */
  preview: string;
  /** The list's own time label ("2h", "Sep 29"). */
  when: string;
  unread: boolean;
}

/**
 * The messaging inbox's left list, newest first: who, the preview, whether
 * unread. Replies to outreach are caught here, then the conversation is read
 * on its `url` by the person (or a later flow). Mapped from the 2026 UI's
 * list items (`li` under `main` whose link is `/messaging/thread/…`); a
 * changed list comes back empty, and the loop treats empty as "nothing new",
 * so `unread` counts are checked against the nav badge too.
 */
export const linkedinInbox = defineFlow<
  InboxInput,
  { conversations: Conversation[]; badge: number }
>({
  site: "linkedin",
  name: "inbox",
  async run(fp, input) {
    const max = input.max ?? 20;
    await go(fp, `${WEB}/messaging/${input.unread ? "?filter=unread" : ""}`);
    if (!(await fp.has({ css: "main" }, RENDER_MS))) return fp.human(`no inbox at ${fp.url()}`);
    await fp.wait(SETTLE_MS * 2);
    const got = await fp.page.evaluate(() => {
      const rows = [...document.querySelectorAll("main li")]
        .filter((li) => li.querySelector("a[href*='/messaging/thread/']"))
        .filter((li) => !li.querySelector("li"));
      const badge = Number(
        /\d+/.exec(
          document.querySelector("a[href*='/messaging/'] .notification-badge__count")
            ?.textContent ?? "",
        )?.[0] ?? "0",
      );
      return {
        badge,
        rows: rows.map((li) => {
          const a = li.querySelector("a[href*='/messaging/thread/']") as { href: string } | null;
          const profile = li.querySelector("a[href*='/in/']") as { href: string } | null;
          const lines =
            (li as { innerText?: string }).innerText
              ?.split("\n")
              .map((l) => l.trim())
              .filter(Boolean) ?? [];
          return {
            url: a?.href ?? "",
            profile: profile?.href ?? "",
            lines,
            unread:
              /\bunread\b/i.test(li.className) ||
              Boolean(li.querySelector("[class*='unread'], .notification-badge")),
          };
        }),
      };
    });
    const conversations: Conversation[] = got.rows.slice(0, max).map((r) => {
      const [name = "", ...rest] = r.lines;
      const when =
        rest.find((l) => /^(\d+[smhdw]|[A-Z][a-z]{2} \d{1,2}|\d{1,2}:\d{2}\s?(AM|PM)?)$/.test(l)) ??
        "";
      const preview = rest
        .filter((l) => l !== when)
        .join(" ")
        .slice(0, 300);
      const v = r.profile ? vanityOf(r.profile) : null;
      return { url: r.url, name, ...(v ? { vanity: v } : {}), preview, when, unread: r.unread };
    });
    return { conversations, badge: got.badge };
  },
});
