/**
 * The toolkit (designs/2026-10-29-one-workflow-system.md §1): every workflow an agent can run,
 * by site. A page's host picks the site's tools; search and the tree find the rest.
 */
import { hostNamed, registrable } from "../auth/guard.js";
import type { SiteLogin } from "../auth/login.js";
import { inputsOf } from "../engine/inputs.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import type { Findable } from "./find.js";
import { withLegs } from "./legs.js";

export interface Tool {
  name: string;
  site: string | null;
  aim: string;
  /** `q, max?`: required names, optional ones with `?`. */
  inputs: string;
  steps: string[];
  irreversible: boolean;
  hosts: readonly string[];
}

/** At most this many tools in an answer; the rest are a count. */
export const TOOLKIT_MAX = 20;

const RECORDED = /^Recorded \d{4}-\d\d-\d\d on /;

export function toolOf(w: AnyWorkflow): Tool {
  const steps = w.steps.map((s) => s.name);
  let inputs = "";
  try {
    inputs = inputsOf(w.plan)
      // top-level fields only: `workflows <name>` has the nested rows
      .filter((f) => !/[.[]/.test(f.name))
      .map((f) => (f.required ? f.name : `${f.name}?`))
      .join(", ");
  } catch {
    // a plan JSON Schema can't hold (a RegExp field): the tree's detail still has the steps
  }
  return {
    name: w.name,
    site: w.site ?? null,
    // A recording's description is its date; the step names say what it does.
    aim: RECORDED.test(w.description) ? steps.join(" → ") : w.description,
    inputs,
    steps,
    irreversible: w.steps.some((s) => Boolean(s.irreversible)),
    hosts: w.hosts ?? [],
  };
}

/** The catalog's workflows, then every leg no workflow shadows by name. */
export function toolsOf(workflows: readonly AnyWorkflow[]): Tool[] {
  return withLegs(workflows).map((w) => toolOf(w as AnyWorkflow));
}

/**
 * The sites a host belongs to. A login's `home` host or registrable domain (and its `origins`);
 * a workflow's own hosts; a site named by the domain (`loom.com` → loom). Exact home host first.
 */
export function sitesOfHost(
  host: string,
  logins: readonly Pick<SiteLogin, "site" | "home" | "origins">[],
  tools: readonly Tool[],
): string[] {
  const h = host.toLowerCase();
  if (!h) return [];
  const reg = registrable(h);
  const hostOf = (u: string) => (URL.canParse(u) ? new URL(u).host : "");
  const exact: string[] = [];
  const near: string[] = [];
  for (const l of logins) {
    const home = hostOf(l.home);
    if (home === h) exact.push(l.site);
    else if (
      (home && registrable(home) === reg) ||
      (l.origins ?? []).some((o) => registrable(o) === reg)
    )
      near.push(l.site);
  }
  for (const t of tools) {
    if (!t.site) continue;
    if (t.hosts.includes(h)) exact.push(t.site);
    else if (t.hosts.some((x) => registrable(x) === reg) || hostNamed(h, t.site)) near.push(t.site);
  }
  return [...new Set([...exact, ...near])];
}

export interface Toolkit {
  sites: string[];
  tools: Pick<Tool, "name" | "aim" | "inputs">[];
  /** Tools past the cap: `{"cmd":"tools","site":…}` lists them. */
  more: number;
}

/** The tools for a page's host, the first site's first; null when no site matches. */
export function toolkitFor(
  host: string,
  logins: readonly Pick<SiteLogin, "site" | "home" | "origins">[],
  tools: readonly Tool[],
  max = TOOLKIT_MAX,
): Toolkit | null {
  const sites = sitesOfHost(host, logins, tools);
  const rank = (t: Tool) => sites.indexOf(t.site ?? "");
  const mine = tools
    .filter((t) => rank(t) >= 0)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  if (!mine.length) return null;
  return {
    sites: sites.filter((s) => mine.some((t) => t.site === s)),
    tools: mine.slice(0, max).map(({ name, aim, inputs }) => ({ name, aim, inputs })),
    more: Math.max(0, mine.length - max),
  };
}

/** A tool as search reads it. */
export const findable = (t: Tool): Tool & Findable => ({
  ...t,
  words: `${t.inputs.replaceAll("?", "")} ${t.steps.join(" ")}`,
});

/** The tree's root: each site and how many tools it has; multi-site workflows under `(any)`. */
export function sitesTree(tools: readonly Tool[]): { site: string; tools: number }[] {
  const n = new Map<string, number>();
  for (const t of tools) n.set(t.site ?? "(any)", (n.get(t.site ?? "(any)") ?? 0) + 1);
  return [...n]
    .map(([site, c]) => ({ site, tools: c }))
    .sort((a, b) => a.site.localeCompare(b.site));
}

export { type Findable, find } from "./find.js";
