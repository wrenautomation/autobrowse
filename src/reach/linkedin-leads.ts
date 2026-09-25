/**
 * LinkedIn people as a lead CSV for wren (`wren email import-people --format
 * linkedin`): who they are, their current role, and, enriched, the
 * employer's website, which is what wren keys the company on and guesses
 * the address from. Each row is appended the moment it is read, and a
 * re-run skips everyone already in the file: stop with Ctrl-C, resume by
 * running it again.
 */
import { type Person, type Profile, pickRole } from "../browser/flows/linkedin-reach.js";

export const LEAD_COLUMNS = [
  "full_name",
  "title",
  "company_name",
  "website",
  "location",
  "linkedin_url",
  "headline",
  "company_linkedin",
  "industry",
  "company_size",
  "company_hq",
  "company_phone",
  "source",
] as const;
export type LeadRow = Record<(typeof LEAD_COLUMNS)[number], string>;

/** "Founder at Lake Hills Wealth" → title and company; the last " at " splits them. */
export function splitRole(role: string | undefined): { title?: string; company?: string } {
  if (!role) return {};
  const i = role.lastIndexOf(" at ");
  if (i <= 0) return { title: role };
  return { title: role.slice(0, i).trim(), company: role.slice(i + 4).trim() };
}

export function leadRow(p: Person, profile?: Profile): LeadRow {
  const role = profile?.roles && pickRole(profile.roles, [p.current, profile.headline]);
  const matched = splitRole(p.current);
  const c = profile?.company;
  return {
    full_name: profile?.name || p.name,
    title: role?.title ?? matched.title ?? p.headline ?? "",
    company_name: c?.name ?? role?.company ?? matched.company ?? "",
    website: c?.website ?? "",
    location: profile?.location ?? p.location ?? "",
    linkedin_url: p.url,
    headline: profile?.headline ?? p.headline ?? "",
    company_linkedin: c?.url ?? role?.companyUrl ?? "",
    industry: c?.industry ?? "",
    company_size: c?.size ?? "",
    company_hq: c?.headquarters ?? "",
    company_phone: c?.phone ?? "",
    source: "linkedin",
  };
}

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export const csvLine = (values: readonly string[]): string => `${values.map(cell).join(",")}\n`;

/** Profile handles already in a lead CSV this module wrote: the rows a re-run skips. */
export function doneVanities(csv: string): Set<string> {
  return new Set([...csv.matchAll(/linkedin\.com\/in\/([^/,"\s]+)\//g)].map((m) => m[1] as string));
}

export interface LeadsDeps {
  /** The people to write: a search, or a company's people. */
  people: () => Promise<Person[]>;
  /** Profile + roles + employer page; absent: the search row alone. */
  enrich?: (p: Person) => Promise<Profile>;
  /** What the file already holds (null: no file yet). */
  existing: string | null;
  append: (text: string) => void;
  /** Between profiles, so the reads come at a person's pace. */
  pause?: () => Promise<void>;
  onRow?: (row: LeadRow, n: number) => void;
  /** A profile that fails: the row is written unenriched and the run goes on. */
  onMiss?: (vanity: string, why: string) => void;
}

export async function writeLeads(
  d: LeadsDeps,
  max: number,
): Promise<{ written: number; skipped: number }> {
  const done = d.existing ? doneVanities(d.existing) : new Set<string>();
  if (!d.existing) d.append(csvLine(LEAD_COLUMNS));
  const people = (await d.people()).slice(0, max);
  let written = 0;
  let skipped = 0;
  for (const p of people) {
    if (done.has(p.vanity)) {
      skipped++;
      continue;
    }
    let profile: Profile | undefined;
    if (d.enrich) {
      if (written) await d.pause?.();
      profile = await d.enrich(p).catch((e: unknown) => {
        d.onMiss?.(p.vanity, e instanceof Error ? e.message : String(e));
        return undefined;
      });
    }
    const row = leadRow(p, profile);
    d.append(csvLine(LEAD_COLUMNS.map((k) => row[k])));
    done.add(p.vanity);
    written++;
    d.onRow?.(row, written);
  }
  return { written, skipped };
}
