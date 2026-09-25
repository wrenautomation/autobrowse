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
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): Iterable<El>;
}
declare const document: El;

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
  /** Also read the experience page: every role, as text. */
  experience?: boolean;
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
  /** The experience page's text, capped: titles, companies, dates, as LinkedIn lays them out. */
  experience?: string;
}

const EXPERIENCE_MAX = 4_000;

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
    if (input.experience) {
      await go(fp, `${WEB}/in/${encodeURIComponent(input.vanity)}/details/experience/`);
      if (await fp.has({ css: "main" }, RENDER_MS)) {
        await fp.wait(SETTLE_MS);
        const text = await fp.page.evaluate(() => document.querySelector("main")?.innerText ?? "");
        const body = text.replace(/^\s*experience\s*/i, "").trim();
        if (body) out.experience = body.slice(0, EXPERIENCE_MAX);
      }
    }
    return out;
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
