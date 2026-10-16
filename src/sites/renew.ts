/**
 * Tokens made again before they stop working. A consent that keeps no
 * refresh token (LinkedIn, a Meta long-lived token) and a minted token
 * (npm) are kept with their lapse date; this finds each one inside the
 * renew window, works out the setup step and account that made it, and
 * runs that step again. A token the platform refused (`refused.ts`) is due
 * at once, placed the same way. The step signs in with the stored
 * credential, so no person is needed. What it cannot place or run is
 * reported, never guessed at.
 */
import { type EnvListing, expiring } from "credvault";
import type { Identity } from "../auth/identities.js";
import { profileBusyOf } from "../browser/browsers.js";
import type { SiteFacade } from "./facade.js";
import { accountEnv } from "./oauth.js";
import { maskAccount, utcOf } from "./refused.js";
import type { SiteApi } from "./types.js";
import { policyAccount } from "./wire.js";

/** A token is made again this long before it lapses (`needs` reopens its row in the same window). */
export const RENEW_WITHIN_MS = 14 * 86_400_000;

export interface Renewal {
  site: string;
  step: string;
  /** The account it runs as; null = the site's own name (the policy's account, kept under both). */
  account: string | null;
  /** The kept names it makes again. */
  names: string[];
  /** When the first lapses; null for a refused token with no lapse date. */
  expiresAt: string | null;
  /** Refused since then (ISO): due however far off its lapse. */
  refused?: string;
}

export interface RenewalPlan {
  due: Renewal[];
  /** Lapsing names no setup step or account accounts for. */
  unplaced: string[];
  /** Refused names no setup step or account accounts for. */
  unplacedRefused: string[];
}

/** The names a step keeps: an OAuth consent's tokens, else what the step says it makes. */
function keptBy(step: SiteApi["setup"][number]): string[] {
  if ("oauth" in step.how) {
    const o = step.how.oauth;
    return [o.refreshToken, ...(o.accessToken ? [o.accessToken] : [])];
  }
  return [...step.makes];
}

/**
 * What to make again, as the setup steps that make it: what lapses within `withinMs` of `now`,
 * and every `refused` name however far off its lapse.
 */
export function renewals(
  sites: readonly SiteApi[],
  identities: readonly Identity[],
  kept: readonly EnvListing[],
  withinMs = RENEW_WITHIN_MS,
  now = Date.now(),
  refused: readonly { name: string; since: string }[] = [],
): RenewalPlan {
  const byKey = new Map<string, Renewal>();
  const unplaced: string[] = [];
  const unplacedRefused: string[] = [];
  /** Every step and account that makes `name`; false when none does. */
  const place = (name: string, at: { expiresAt: string | null; refused?: string }): boolean => {
    let placed = false;
    for (const s of sites)
      for (const step of s.setup)
        for (const base of keptBy(step)) {
          const account =
            name === base
              ? null
              : name.startsWith(`${base}__`)
                ? (identities.find((i) => accountEnv(base, i.address) === name)?.address ??
                  undefined)
                : undefined;
          if (account === undefined) continue;
          placed = true;
          const key = `${s.site}\n${step.name}\n${account ?? ""}`;
          const r = byKey.get(key);
          if (r) {
            if (!r.names.includes(name)) r.names.push(name);
            r.expiresAt ??= at.expiresAt;
            if (at.refused) r.refused ??= at.refused;
          } else
            byKey.set(key, {
              site: s.site,
              step: step.name,
              account,
              names: [name],
              expiresAt: at.expiresAt,
              ...(at.refused ? { refused: at.refused } : {}),
            });
        }
    return placed;
  };
  const lapse = new Map(kept.map((e) => [e.name, e.expiresAt]));
  for (const r of refused)
    if (!place(r.name, { expiresAt: lapse.get(r.name) ?? null, refused: r.since }))
      unplacedRefused.push(r.name);
  for (const e of expiring(kept, withinMs, now))
    if (!place(e.name, { expiresAt: e.expiresAt as string })) unplaced.push(e.name);
  // A run as the site's own name is the policy's account, kept under both: one run covers both.
  const due = [...byKey.values()].filter((r) => {
    if (!r.account || !byKey.has(`${r.site}\n${r.step}\n`)) return true;
    const s = sites.find((x) => x.site === r.site);
    const step = s?.setup.find((x) => x.name === r.step);
    return !s || policyAccount(identities, s, step) !== r.account;
  });
  return { due, unplaced, unplacedRefused };
}

export interface RenewResult extends Renewal {
  ok: boolean;
  made?: readonly string[];
  error?: string;
  /** Its browser profile was open elsewhere: nothing reached the site. */
  busy?: boolean;
}

/**
 * Run each due step once, in turn (each may drive a browser); one failing never stops the rest.
 * `before` is told as each starts, so a try that never ends still counts.
 */
export async function renewDue(
  facade: Pick<SiteFacade, "setup">,
  plan: RenewalPlan,
  before?: (r: Renewal) => void,
): Promise<RenewResult[]> {
  const out: RenewResult[] = [];
  for (const r of plan.due) {
    before?.(r);
    try {
      const { made } = await facade.setup(r.site, r.step, r.account);
      out.push({ ...r, ok: true, made });
    } catch (err) {
      out.push({
        ...r,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ...(profileBusyOf(err) ? { busy: true } : {}),
      });
    }
  }
  return out;
}

const masked = (a: string | null) => (a ? ` as ${maskAccount(a)}` : "");
const why = (r: Renewal) =>
  r.refused ? `refused since ${utcOf(r.refused)}` : `lapses ${r.expiresAt}`;

/** One line per result (per due step, dry), for a channel or a terminal: names and dates, never a value or a whole address. */
export function renewWording(plan: RenewalPlan, results: readonly RenewResult[] | null): string[] {
  return [
    ...(results ?? plan.due.map((r) => ({ ...r, ok: null }))).map((r) =>
      r.ok === null
        ? `due: ${r.site} ${r.step}${masked(r.account)} (${why(r)})`
        : r.ok
          ? `${r.refused ? "re-made" : "renewed"} ${r.site} ${r.step}${masked(r.account)} (${r.refused ? why(r) : `was lapsing ${r.expiresAt}`})`
          : `could not ${r.refused ? "re-make" : "renew"} ${r.site} ${r.step}${masked(r.account)} (${why(r)}): ${"error" in r ? r.error : ""}`,
    ),
    ...plan.unplaced.map((n) => `${n} lapses soon and no setup step makes it: renew it by hand`),
    ...plan.unplacedRefused.map(
      (n) => `${n} was refused and no setup step makes it: make it by hand`,
    ),
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
