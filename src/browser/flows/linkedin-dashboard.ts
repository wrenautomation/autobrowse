/**
 * The signed-in account's own dashboard (`/dashboard/`), read as Wren's
 * account: profile viewers, search appearances, post impressions and
 * followers. Read only: one page load, it never clicks.
 *
 * Counts are read off the visible text the way the post analytics page is
 * (`countsOf`): a count before its label, after it, or on its line. Each
 * count may carry its window ("Past 90 days", "Previous week") on a line
 * near its label; those lines are kept and left out of the pairing.
 * Unproven live: no live read was made.
 */
import { defineFlow, type FlowPage } from "../flow.js";
import { countsOf, RAW_CAP } from "./linkedin-post-analytics.js";
import { go } from "./linkedin-reach.js";

export const DASHBOARD_URL = "https://www.linkedin.com/dashboard/";
const RENDER_MS = 15_000;
const SETTLE_MS = 1_500;
const SETTLE_TRIES = 4;

export interface DashboardStats {
  profileViewers: number | null;
  searchAppearances: number | null;
  postImpressions: number | null;
  followers: number | null;
}

export interface Dashboard extends DashboardStats {
  /** Each count's window as the page words it, or null when it shows none. */
  windows: Record<keyof DashboardStats, string | null>;
  /** The page read. */
  url: string;
  /** The page text, capped. */
  raw: string;
}

/** Each count's labels as the page writes them, lowercase; the longer one first. */
const LABELS: Record<keyof DashboardStats, string[]> = {
  profileViewers: ["profile viewers", "profile views"],
  searchAppearances: ["search appearances"],
  postImpressions: ["post impressions"],
  followers: ["total followers", "followers"],
};
const KEYS = Object.keys(LABELS) as Array<keyof DashboardStats>;
const WINDOW = /^(past \d+ days|last \d+ days|past week|previous week|past year)$/i;
/** How far past its label a count's window may sit. */
const WINDOW_REACH = 2;

const COUNT = "\\d[\\d,.]*\\s*[KkMm]?";
/** The label alone on its line, or with its count: "Followers", "1,204 Followers", "Followers: 1,204". */
const isLabel = (line: string, k: keyof DashboardStats) =>
  LABELS[k].some((label) =>
    new RegExp(`^(${COUNT}\\s+)?${label}:?(\\s+${COUNT})?$`, "i").test(line),
  );

/** The window line that follows a label within a couple of lines, before the next label. */
function windowsOf(lines: string[]): Record<keyof DashboardStats, string | null> {
  const out = Object.fromEntries(KEYS.map((k) => [k, null])) as Record<
    keyof DashboardStats,
    string | null
  >;
  for (const k of KEYS) {
    const at = lines.findIndex((l) => isLabel(l, k));
    if (at < 0) continue;
    for (let j = at + 1; j <= at + WINDOW_REACH && j < lines.length; j++) {
      const line = lines[j] ?? "";
      if (KEYS.some((other) => isLabel(line, other))) break;
      if (WINDOW.test(line)) {
        out[k] = line;
        break;
      }
    }
  }
  return out;
}

/** The dashboard's counts and their windows; a missing label is null. */
export function dashboardOf(text: string): DashboardStats & Pick<Dashboard, "windows"> {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return { ...countsOf(text, LABELS, (l) => WINDOW.test(l)), windows: windowsOf(lines) };
}

const shows = (s: DashboardStats) => s.profileViewers !== null || s.searchAppearances !== null;

export const linkedinDashboard = defineFlow<Record<string, never>, Dashboard>({
  site: "linkedin",
  name: "dashboard",
  async run(fp: FlowPage) {
    await go(fp, DASHBOARD_URL);
    if (!(await fp.has({ css: "main" }, RENDER_MS))) return fp.human(`no page at ${fp.url()}`);
    for (let i = 0; i < SETTLE_TRIES; i++) {
      const text = await fp.text();
      const got = dashboardOf(text);
      if (shows(got)) return { ...got, url: fp.url(), raw: text.slice(0, RAW_CAP) };
      await fp.wait(SETTLE_MS);
    }
    return fp.human(
      `${fp.url()} is not the dashboard: it shows neither profile viewers nor search appearances`,
    );
  },
});
