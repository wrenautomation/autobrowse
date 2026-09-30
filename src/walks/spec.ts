/**
 * A walk as data: the screens a goal passes through on a site, each known by
 * its URL shape and landmarks, each with the ops done there. Built from runs
 * that reached the goal (walks/build.ts) and run by one interpreter
 * (walks/flow.ts) as a screens walk (browser/screens.ts): the page decides
 * which screen comes next, so a run that took another branch adds a screen,
 * not a script. Plain JSON a person can edit, one file per walk:
 * `walks/<site>/<name>.json` beside the owner's other state.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { fieldSchema, opSchema } from "../compiler/outline.js";
import { baseSite } from "../runs/log.js";

export const WALK_VERSION = 1;
/** How deep walks may nest: a walk op inside a walk inside a walk… */
export const MAX_DEPTH = 4;

const NAME = /^[a-z][a-z0-9-]*$/;
const SITE = /^[a-z0-9][a-z0-9._-]*$/i;
/** A placed secret's name as the explore server takes it: `code`, `google.password`, `google-admin.code`. */
const SECRET_KEY = /^[a-z][\w-]*(@[\w-]+)?(\.[a-zA-Z]\w*)*$/;

/** The outline's ops, plus what a walk adds: a page to open, a captcha, another walk. */
export const walkOpSchema = z.discriminatedUnion("kind", [
  ...opSchema.options,
  z.object({ kind: z.literal("open"), goal: z.string(), url: z.string().url() }),
  z.object({ kind: z.literal("captcha"), goal: z.string() }),
  /** Another walk, by `name` on this site or `site/name`: a sign-in inside a setup. */
  z.object({
    kind: z.literal("walk"),
    goal: z.string(),
    walk: z.string().regex(/^([a-z0-9][a-z0-9._-]*\/)?[a-z][a-z0-9-]*$/),
  }),
]);
export type WalkOp = z.infer<typeof walkOpSchema>;

export const screenSpecSchema = z.object({
  name: z.string().regex(NAME),
  /** One line a person would say about it. */
  looks: z.string(),
  /** Its URL shape (`urlShape`: host and path, ids as `*`); null: any page. */
  url: z.string().nullable(),
  /** All on the page (`lookAt` landmarks): it is this screen. */
  landmarks: z.array(z.string()).max(12),
  ops: z.array(walkOpSchema),
  goal: z.boolean().optional(),
  /** Screens that must be done first: the second visit to a page, or a page two screens share. */
  after: z.array(z.string().regex(NAME)).optional(),
  /** Done at most once per walk (the default); false for a page that may come back (a next page). */
  once: z.boolean().optional(),
  /** How many of the runs it was built from passed through it. */
  seen: z.number().int().nonnegative(),
});
export type ScreenSpec = z.infer<typeof screenSpecSchema>;

export const walkSpecSchema = z
  .object({
    version: z.literal(WALK_VERSION),
    site: z.string().regex(SITE),
    name: z.string().regex(NAME),
    /** In words: what the walk ends with. */
    goal: z.string(),
    built: z.string(),
    /** The runs it was built from, oldest first. */
    from: z.array(z.object({ run: z.string(), outcome: z.string(), endedAt: z.string() })),
    /** Where it opens; null: it starts on whatever page it is handed (a walk inside a walk). */
    start: z.string().url().nullable(),
    /** Typed values: the run's value is the example, used when the input does not give one. */
    fields: z.array(fieldSchema),
    secrets: z.array(z.object({ key: z.string().regex(SECRET_KEY), label: z.string() })),
    /** A click on it creates, sends or pays: running it takes a yes. */
    irreversible: z.boolean(),
    screens: z.array(screenSpecSchema).min(1),
  })
  .superRefine((w, ctx) => {
    const names = new Set<string>();
    w.screens.forEach((s, i) => {
      if (names.has(s.name))
        ctx.addIssue({ code: "custom", path: ["screens", i, "name"], message: "not unique" });
      names.add(s.name);
      if (s.goal && s.ops.length)
        ctx.addIssue({
          code: "custom",
          path: ["screens", i, "ops"],
          message: "a goal does nothing",
        });
    });
    if (!w.screens.some((s) => s.goal))
      ctx.addIssue({ code: "custom", path: ["screens"], message: "no goal screen" });
    const fields = new Set(w.fields.map((f) => f.key));
    const secrets = new Set(w.secrets.map((s) => s.key));
    w.screens.forEach((s, i) => {
      for (const a of s.after ?? [])
        if (!names.has(a))
          ctx.addIssue({
            code: "custom",
            path: ["screens", i, "after"],
            message: `names no screen: ${a}`,
          });
      s.ops.forEach((op, j) => {
        const v = op.kind === "fill" ? op.value : op.kind === "upload" ? op.file : null;
        if (v?.from === "plan" && !fields.has(v.field))
          ctx.addIssue({
            code: "custom",
            path: ["screens", i, "ops", j],
            message: `field ${v.field} is not declared`,
          });
        if (v?.from === "secret" && !secrets.has(v.key))
          ctx.addIssue({
            code: "custom",
            path: ["screens", i, "ops", j],
            message: `secret ${v.key} is not declared`,
          });
      });
    });
  });
export type WalkSpec = z.infer<typeof walkSpecSchema>;

export const walkFile = (dir: string, site: string, name: string): string => {
  const s = baseSite(site);
  if (!SITE.test(s)) throw new Error(`site "${site}" cannot name a walks folder`);
  if (!NAME.test(name)) throw new Error(`"${name}" is not a walk name (kebab-case)`);
  return join(dir, s, `${name}.json`);
};

/** Written whole or not at all: a temp file, then a rename. */
export function saveWalk(dir: string, spec: WalkSpec): string {
  const w = walkSpecSchema.parse(spec);
  const file = walkFile(dir, w.site, w.name);
  mkdirSync(join(dir, baseSite(w.site)), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(w, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

/** A walk by `name` on `site`, or `site/name`; null when there is none. A hand edit that breaks the schema throws. */
export function loadWalk(dir: string, site: string, name: string): WalkSpec | null {
  const [s, n] = name.includes("/") ? (name.split("/") as [string, string]) : [site, name];
  const file = walkFile(dir, s, n);
  if (!existsSync(file)) return null;
  const parsed = walkSpecSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success)
    throw new Error(`walk ${baseSite(s)}/${n}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

export interface WalkListing {
  site: string;
  name: string;
  goal: string;
  screens: number;
  runs: number;
  irreversible: boolean;
  built: string;
}

/** Every walk, by site then name; a file that does not parse is listed with its error as the goal. */
export function listWalks(dir: string): WalkListing[] {
  if (!existsSync(dir)) return [];
  const out: WalkListing[] = [];
  for (const site of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!site.isDirectory()) continue;
    for (const f of readdirSync(join(dir, site.name)).sort()) {
      if (!f.endsWith(".json")) continue;
      const name = f.slice(0, -5);
      try {
        const w = loadWalk(dir, site.name, name);
        if (w)
          out.push({
            site: w.site,
            name: w.name,
            goal: w.goal,
            screens: w.screens.length,
            runs: w.from.length,
            irreversible: w.irreversible,
            built: w.built,
          });
      } catch (err) {
        out.push({
          site: site.name,
          name,
          goal: `(broken: ${err instanceof Error ? err.message : String(err)})`,
          screens: 0,
          runs: 0,
          irreversible: true,
          built: "",
        });
      }
    }
  }
  return out;
}
