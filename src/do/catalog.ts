/**
 * Everything autobrowse can do right now, in one list a caller (or a
 * model) can pick from: site routes under their official shapes, compiled
 * workflows, hand-written browser flows. A row that cannot answer yet
 * (a browser leg nobody recorded) stays in the list with what is missing:
 * that is what the agent builds when `do` is asked for it.
 */
import type { AnyWorkflow } from "../engine/workflow.js";
import type { SiteRow } from "../sites/facade.js";
import type { SiteApi } from "../sites/types.js";

export type AbilityKind = "site" | "workflow" | "flow";

export interface Ability {
  kind: AbilityKind;
  /** `youtube POST /youtube/v3/videos` | a workflow's name | `google/oauth-consent`. */
  name: string;
  site: string | null;
  summary: string;
  /** Input field names it takes (a route's request, a workflow's plan). */
  inputs: string[];
  irreversible: boolean;
  /** It answers now; `missing` says why not. */
  ready: boolean;
  missing: string | null;
}

export const siteAbilityName = (site: string, method: string, path: string) =>
  `${site} ${method} ${path}`;

/** `youtube POST /youtube/v3/videos` → its parts; null for any other shape. */
export function parseSiteAbility(
  name: string,
): { site: string; method: string; path: string } | null {
  const m = /^([a-z0-9-]+) (GET|POST|PUT|PATCH|DELETE) (\/\S*)$/.exec(name);
  return m ? { site: m[1] as string, method: m[2] as string, path: m[3] as string } : null;
}

/** Field names of an object schema; nothing for any other shape. */
export function fieldsOf(schema: unknown): string[] {
  const shape = (schema as { shape?: unknown } | null)?.shape;
  return shape && typeof shape === "object" ? Object.keys(shape as object) : [];
}

export interface AbilitySources {
  /** The site modules (request shapes) and their live rows (how each route answers now). */
  sites?: { apis: readonly SiteApi[]; rows: readonly SiteRow[] };
  /** Compiled workflows (hand-written ones take plans no goal maps onto). */
  workflows?: readonly AnyWorkflow[];
  /** Hand-written flows by `site/name`. */
  flows?: readonly string[];
}

export function abilitiesOf(s: AbilitySources): Ability[] {
  const out: Ability[] = [];
  for (const api of s.sites?.apis ?? []) {
    const row = s.sites?.rows.find((r) => r.site === api.site);
    for (const route of api.routes) {
      const live = row?.routes.find((r) => r.method === route.method && r.path === route.path);
      out.push({
        kind: "site",
        name: siteAbilityName(api.site, route.method, route.path),
        site: api.site,
        summary: route.summary,
        inputs: fieldsOf(route.request),
        irreversible: Boolean(route.irreversible),
        ready: live ? live.via !== "none" : false,
        missing: live?.missing ?? (live ? null : "site not served here"),
      });
    }
  }
  for (const w of s.workflows ?? [])
    out.push({
      kind: "workflow",
      name: w.name,
      site: null,
      summary: w.description,
      inputs: fieldsOf(w.plan).filter((f) => f !== "dryRun"),
      irreversible: w.steps.some((st) => Boolean(st.irreversible)),
      ready: true,
      missing: null,
    });
  for (const f of s.flows ?? [])
    out.push({
      kind: "flow",
      name: f,
      site: f.split("/")[0] ?? null,
      summary: `hand-written browser flow ${f}`,
      inputs: [],
      irreversible: false,
      ready: true,
      missing: null,
    });
  return out;
}
