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

export type AbilityKind = "site" | "workflow" | "flow" | "tool";

export interface Ability {
  kind: AbilityKind;
  /** `youtube POST /youtube/v3/videos` | a workflow's name | `google/oauth-consent` | `wrangler-deploy`. */
  name: string;
  site: string | null;
  summary: string;
  /** The input fields it takes (a route's request, a workflow's plan). */
  inputs: Field[];
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

export interface Field {
  name: string;
  /** A path segment of the route (`/youtube/v3/{resource}`): required, and only the value. */
  inPath?: boolean;
  /** The values an enum field takes. */
  values?: string[];
  type?: string;
}

/** Fields of an object schema (zod 4: name, type, enum values); nothing for any other shape. */
export function fieldsOf(schema: unknown, path = ""): Field[] {
  const shape = (schema as { shape?: unknown } | null)?.shape;
  if (!shape || typeof shape !== "object") return [];
  return Object.entries(shape as Record<string, unknown>).map(([name, v]) => {
    let t = v as { def?: { type?: string; innerType?: unknown }; options?: unknown };
    while (t?.def?.innerType) t = t.def.innerType as typeof t;
    const values = Array.isArray(t?.options) ? t.options.map(String) : undefined;
    return {
      name,
      ...(path.includes(`{${name}}`) ? { inPath: true } : {}),
      ...(values ? { values } : {}),
      ...(t?.def?.type ? { type: t.def.type } : {}),
    };
  });
}

/** `resource (path: videos|channels)`, `part`, `mine (boolean)`: one field as the picker reads it. */
export const fieldLine = (f: Field): string => {
  const notes = [
    ...(f.inPath ? ["path"] : []),
    ...(f.values ? [f.values.join("|")] : f.type && f.type !== "string" ? [f.type] : []),
  ];
  return notes.length ? `${f.name} (${notes.join(": ")})` : f.name;
};

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
        inputs: fieldsOf(route.request, route.path),
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
      inputs: fieldsOf(w.plan).filter((f) => f.name !== "dryRun"),
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
