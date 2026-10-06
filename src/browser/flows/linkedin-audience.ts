/**
 * The signed-in account's audience: its own followers and connections (its
 * profile at `/in/me/`), and a company Page's followers (the Page's top card).
 * Two page loads, read only: it never clicks.
 *
 * Counts are read off the visible text, as a person reads them: "1,204
 * followers", "500+ connections" (a floor: LinkedIn stops counting there on a
 * profile), "12K followers" on a Page. The text each came from is kept whole.
 */
import { defineFlow } from "../flow.js";
import { go } from "./linkedin-reach.js";

const WEB = "https://www.linkedin.com";
const RENDER_MS = 15_000;
/** Wren's Page, by its numeric id (the same one `linkedin-page-branding` edits). */
export const WREN_PAGE = "143656154";

export interface Count {
  n: number;
  /** As the page says it: "500+", "1.2K". */
  label: string;
}

export interface Audience {
  followers: number;
  connections?: Count;
  page?: { id: string; followers: number; label: string };
  raw: { profile: string; page?: string };
}

const SUFFIX: Record<string, number> = { k: 1_000, m: 1_000_000 };

/** The first "<n> <noun>" in the text: "1,204 followers", "500+ connections", "1.2K followers". */
export function countOf(text: string, noun: "followers" | "connections"): Count | null {
  const m = new RegExp(`(\\d[\\d,.]*)\\s*([KkMm])?(\\+)?\\s+${noun}\\b`).exec(text);
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(/,/g, "")) * (SUFFIX[(m[2] ?? "").toLowerCase()] ?? 1);
  return Number.isFinite(n)
    ? { n: Math.round(n), label: `${m[1]}${m[2] ?? ""}${m[3] ?? ""}` }
    : null;
}

export interface AudienceInput {
  /** A company Page's handle or numeric id (default Wren's); "" skips the Page. */
  page?: string;
}

export const linkedinAudience = defineFlow<AudienceInput, Audience>({
  site: "linkedin",
  name: "audience",
  async run(fp, input) {
    await go(fp, `${WEB}/in/me/`);
    if (!(await fp.has({ css: "main section" }, RENDER_MS)))
      return fp.human(`no profile at ${fp.url()}`);
    const profile = await fp.text();
    const followers = countOf(profile, "followers");
    if (!followers) return fp.human(`the profile at ${fp.url()} shows no follower count`);
    const connections = countOf(profile, "connections");
    const out: Audience = {
      followers: followers.n,
      ...(connections ? { connections } : {}),
      raw: { profile },
    };
    const id = input.page ?? WREN_PAGE;
    if (!id) return out;
    await go(fp, `${WEB}/company/${encodeURIComponent(id)}/`);
    if (!(await fp.has({ css: "main section" }, RENDER_MS)))
      return fp.human(`no company page at ${fp.url()}`);
    const page = await fp.text();
    const pf = countOf(page, "followers");
    if (!pf) return fp.human(`the Page at ${fp.url()} shows no follower count`);
    return { ...out, page: { id, followers: pf.n, label: pf.label }, raw: { profile, page } };
  },
});
