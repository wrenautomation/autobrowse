/**
 * Mods: what autobrowse learned about a site, packed so another owner or
 * install can use it without learning it again (designs/2026-10-04-mods.md).
 * A mod is `mod.json` plus data files an existing interpreter reads (walks,
 * screens, fixes). Installed mods sit in `<state>/mods/<dir>/`; the owner's
 * own files always win over a mod's.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type Fix, type Fixes, memoryFixes } from "../browser/fixes.js";
import { type LearnedScreen, type LearnedScreens, memoryScreens } from "../browser/screens.js";
import { hintsSchema } from "../compiler/outline.js";

export const MOD_KEYWORD = "autobrowse-mod";
export const GATES = ["purchase", "password", "send", "choose", "human"] as const;

/** Where each kind's files sit in a mod. Data kinds only: no file here can run new code. */
export const KIND_DIRS = { walk: "walks/", screens: "screens/", fixes: "fixes/" } as const;
export type ModKind = keyof typeof KIND_DIRS;
const KINDS = Object.keys(KIND_DIRS) as [ModKind, ...ModKind[]];

const SITE = /^[a-z0-9][a-z0-9._-]*$/;
const DOMAIN = /^([a-z0-9-]+\.)+[a-z0-9-]+$|^(localhost|127\.0\.0\.1)(:\d+)?$/;
/** A safe relative path: no `..`, no leading `/`, plain characters. */
const PATH = /^(?!.*\.\.)[a-z0-9][\w./-]*\.json$/i;

/** An npm name: `name` or `@scope/name`. */
export const MOD_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;

export const modSchema = z
  .object({
    name: z.string().regex(MOD_NAME),
    version: z.string().regex(/^\d+\.\d+\.\d+/),
    /** The autobrowse versions it works with: `>=x.y.z`. */
    autobrowse: z.string().regex(/^>=\d+\.\d+\.\d+$/),
    description: z.string(),
    sites: z.array(z.string().regex(SITE)).min(1),
    /** Every origin a file may open: hosts, each with its subdomains. */
    domains: z.array(z.string().regex(DOMAIN)).min(1),
    gates: z.array(z.enum(GATES)),
    /** `site:role` pairs it asks for; never a value. */
    credentials: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]*:[a-z][a-z0-9-]*$/)),
    irreversible: z.boolean(),
    files: z
      .array(
        z.object({
          kind: z.enum(KINDS),
          path: z.string().regex(PATH),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
        }),
      )
      .min(1),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.files.forEach((f, i) => {
      if (!f.path.startsWith(KIND_DIRS[f.kind]))
        ctx.addIssue({
          code: "custom",
          path: ["files", i, "path"],
          message: `a ${f.kind} lives under ${KIND_DIRS[f.kind]}`,
        });
      if (seen.has(f.path))
        ctx.addIssue({ code: "custom", path: ["files", i], message: "listed twice" });
      seen.add(f.path);
    });
  });
export type Mod = z.infer<typeof modSchema>;

/** A learned screen as a mod carries it: no counts, no dates (the installer's own). */
export const modScreenSchema = z.object({
  site: z.string().regex(SITE),
  url: z.string(),
  landmarks: z.array(z.string()).min(2).max(12),
  walk: z.string().optional(),
  screen: z.string().optional(),
  click: hintsSchema.optional(),
  reason: z.string(),
});
export const modFixSchema = z.object({
  flow: z.string().regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][\w-]*$/),
  goal: z.string(),
  failed: hintsSchema,
  hints: hintsSchema,
  detours: z.array(hintsSchema).optional(),
  reason: z.string(),
  url: z.string(),
});

/** The folder a mod installs into: `@a/b` → `a__b`. */
export const modDirName = (name: string): string => name.replace(/^@/, "").replace("/", "__");

/** A host is inside the mod's domains when it is one of them or a subdomain of one. */
export function inDomains(host: string, domains: readonly string[]): boolean {
  const h = host.toLowerCase();
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/** The host of a URL or of a URL shape (`app.cal.com/*\/x`). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.split("/")[0] ?? "";
  }
}

export interface Installed {
  dir: string;
  mod: Mod;
  /** Where it came from and when (`installed.json`). */
  source: string;
  at: string;
}

/** Every mod installed under `modsDir`; one that does not parse is skipped. */
export function installedMods(modsDir: string): Installed[] {
  if (!existsSync(modsDir)) return [];
  const out: Installed[] = [];
  for (const d of readdirSync(modsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = join(modsDir, d.name);
    try {
      const mod = modSchema.parse(JSON.parse(readFileSync(join(dir, "mod.json"), "utf8")));
      const rec = JSON.parse(readFileSync(join(dir, "installed.json"), "utf8")) as {
        source: string;
        at: string;
      };
      out.push({ dir, mod, source: rec.source, at: rec.at });
    } catch {
      // Half-written or hand-broken: not loaded.
    }
  }
  return out.sort((a, b) => a.mod.name.localeCompare(b.mod.name));
}

function rowsOf<T>(m: Installed, kind: ModKind, schema: z.ZodType<T>): T[] {
  return m.mod.files
    .filter((f) => f.kind === kind)
    .flatMap((f) => {
      try {
        return z.array(schema).parse(JSON.parse(readFileSync(join(m.dir, f.path), "utf8")));
      } catch {
        return [];
      }
    });
}

/** Every installed mod's learned screens, marked with the mod. */
export const modScreens = (modsDir: string): LearnedScreen[] =>
  installedMods(modsDir).flatMap((m) =>
    rowsOf(m, "screens", modScreenSchema).map((r) => ({
      ...(r as Omit<LearnedScreen, "found" | "used">),
      found: m.at,
      used: 0,
      from: m.mod.name,
    })),
  );

/** Every installed mod's fixes, marked with the mod. */
export const modFixes = (modsDir: string): Fix[] =>
  installedMods(modsDir).flatMap((m) =>
    rowsOf(m, "fixes", modFixSchema).map((r) => ({
      ...(r as Omit<Fix, "found" | "used">),
      found: m.at,
      used: 0,
      from: m.mod.name,
    })),
  );

/**
 * The owner's learned screens first, then mods'. A mod's screen that works
 * is copied into the owner's file with `from`, so it outlives the mod.
 */
export function withModScreens(own: LearnedScreens, rows: LearnedScreen[]): LearnedScreens {
  if (!rows.length) return own;
  const mods = memoryScreens(undefined, rows);
  const theirs = new Set(rows);
  return {
    ...own,
    find: (site, walk, look) => own.find(site, walk, look) ?? mods.find(site, walk, look),
    has: (site) => own.has(site) || mods.has(site),
    used(row) {
      if (!theirs.has(row)) return own.used(row);
      const { found: _f, used: _u, lastUsed: _l, ...kept } = row;
      own.keep(kept);
      theirs.delete(row);
      mods.drop(row);
    },
    drop: (row) => (theirs.has(row) ? mods.drop(row) : own.drop(row)),
  };
}

/** The owner's fixes first, then mods'. A mod's fix that works is copied into the owner's file with `from`. */
export function withModFixes(own: Fixes, rows: Fix[]): Fixes {
  if (!rows.length) return own;
  const mods = memoryFixes(undefined, rows);
  const theirs = (flow: string, goal: string, failed: Fix["failed"]) =>
    !own.find(flow, goal, failed) && mods.find(flow, goal, failed)
      ? mods.list().find((f) => f.flow === flow && f.goal === goal && sameHints(f.failed, failed))
      : undefined;
  return {
    ...own,
    find: (flow, goal, failed) => own.find(flow, goal, failed) ?? mods.find(flow, goal, failed),
    used(flow, goal, failed) {
      const f = theirs(flow, goal, failed);
      if (!f) return own.used(flow, goal, failed);
      own.keep({ ...f, found: new Date().toISOString(), used: 1 });
      mods.drop(flow, goal, failed);
    },
    // ponytail: a dropped mod fix is gone for this process only; the next start tries it again.
    drop(flow, goal, failed) {
      if (theirs(flow, goal, failed)) mods.drop(flow, goal, failed);
      else own.drop(flow, goal, failed);
    },
  };
}

const sameHints = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
