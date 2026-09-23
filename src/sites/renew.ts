/**
 * Tokens that lapse, made again before they do. A consent that keeps no
 * refresh token (LinkedIn, a Meta long-lived token) and a minted token
 * (npm) are kept with their lapse date; this finds each one inside the
 * renew window, works out the setup step and account that made it, and
 * runs that step again. The step signs in with the stored credential, so
 * no person is needed. What it cannot place or run is reported, never
 * guessed at.
 */
import { type EnvListing, expiring } from "credvault";
import type { Identity } from "../auth/identities.js";
import type { SiteFacade } from "./facade.js";
import { accountEnv } from "./oauth.js";
import type { SiteApi } from "./types.js";
import { policyAccount } from "./wire.js";

/** A token is made again this long before it lapses (`needs` reopens its row in the same window). */
export const RENEW_WITHIN_MS = 14 * 86_400_000;

export interface Renewal {
  site: string;
  step: string;
  /** The account it runs as; null = the site's own name (the policy's account, kept under both). */
  account: string | null;
  /** The kept names it makes again, and when the first lapses. */
  names: string[];
  expiresAt: string;
}

export interface RenewalPlan {
  due: Renewal[];
  /** Lapsing names no setup step or account accounts for. */
  unplaced: string[];
}

/** The names a step keeps: an OAuth consent's tokens, else what the step says it makes. */
function keptBy(step: SiteApi["setup"][number]): string[] {
  if ("oauth" in step.how) {
    const o = step.how.oauth;
    return [o.refreshToken, ...(o.accessToken ? [o.accessToken] : [])];
  }
  return [...step.makes];
}

/** What lapses within `withinMs` of `now`, as the setup steps that make it again. */
export function renewals(
  sites: readonly SiteApi[],
  identities: readonly Identity[],
  kept: readonly EnvListing[],
  withinMs = RENEW_WITHIN_MS,
  now = Date.now(),
): RenewalPlan {
  const byKey = new Map<string, Renewal>();
  const unplaced: string[] = [];
  for (const e of expiring(kept, withinMs, now)) {
    let placed = false;
    for (const s of sites)
      for (const step of s.setup)
        for (const base of keptBy(step)) {
          const account =
            e.name === base
              ? null
              : e.name.startsWith(`${base}__`)
                ? (identities.find((i) => accountEnv(base, i.address) === e.name)?.address ??
                  undefined)
                : undefined;
          if (account === undefined) continue;
          placed = true;
          const key = `${s.site}\n${step.name}\n${account ?? ""}`;
          const r = byKey.get(key);
          if (r) r.names.push(e.name);
          else
            byKey.set(key, {
              site: s.site,
              step: step.name,
              account,
              names: [e.name],
              expiresAt: e.expiresAt as string,
            });
        }
    if (!placed) unplaced.push(e.name);
  }
  // A run as the site's own name is the policy's account, kept under both: one run covers both.
  const due = [...byKey.values()].filter((r) => {
    if (!r.account || !byKey.has(`${r.site}\n${r.step}\n`)) return true;
    const s = sites.find((x) => x.site === r.site);
    const step = s?.setup.find((x) => x.name === r.step);
    return !s || policyAccount(identities, s, step) !== r.account;
  });
  return { due, unplaced };
}

export interface RenewResult extends Renewal {
  ok: boolean;
  made?: readonly string[];
  error?: string;
}

/** Run each due step once, in turn (each may drive a browser); one failing never stops the rest. */
export async function renewDue(facade: SiteFacade, plan: RenewalPlan): Promise<RenewResult[]> {
  const out: RenewResult[] = [];
  for (const r of plan.due) {
    try {
      const { made } = await facade.setup(r.site, r.step, r.account);
      out.push({ ...r, ok: true, made });
    } catch (err) {
      out.push({ ...r, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

const masked = (a: string | null) => (a ? ` as ${a.replace(/^(.)[^@]*@/, "$1***@")}` : "");

/** One line per result (per due step, dry), for a channel or a terminal: names and dates, never a value or a whole address. */
export function renewWording(plan: RenewalPlan, results: readonly RenewResult[] | null): string[] {
  return [
    ...(results ?? plan.due.map((r) => ({ ...r, ok: null }))).map((r) =>
      r.ok === null
        ? `due: ${r.site} ${r.step}${masked(r.account)} (lapses ${r.expiresAt})`
        : r.ok
          ? `renewed ${r.site} ${r.step}${masked(r.account)} (was lapsing ${r.expiresAt})`
          : `could not renew ${r.site} ${r.step}${masked(r.account)} (lapses ${r.expiresAt}): ${"error" in r ? r.error : ""}`,
    ),
    ...plan.unplaced.map((n) => `${n} lapses soon and no setup step makes it: renew it by hand`),
  ];
}

export interface RenewReport extends RenewalPlan {
  /** Empty on a dry run. */
  results: RenewResult[];
  lines: string[];
  /** When the soonest kept token a step makes lapses, after this run: a scheduler's next look is 14 days before. */
  next: string | null;
}

/** The soonest lapse among the kept tokens a setup step makes again. */
export function nextLapse(
  sites: readonly SiteApi[],
  identities: readonly Identity[],
  kept: readonly EnvListing[],
): string | null {
  return renewals(sites, identities, kept, Number.POSITIVE_INFINITY).due[0]?.expiresAt ?? null;
}
