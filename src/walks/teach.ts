/**
 * Teach (designs/2026-10-05-teach-mode.md): a chore done once by hand
 * becomes a walk. The build guessed where each value comes from next time
 * (walks/build.ts); here a person confirms or changes each guess, and the
 * walk is packed into a mod when asked. Nothing personal is packed unless
 * the review said so.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { camel } from "../compiler/structure.js";
import { checkMod, sha256 } from "../mods/install.js";
import { hostOf, MOD_KEYWORD, type Mod, modSchema } from "../mods/mod.js";
import { baseSite } from "../runs/log.js";
import type { Guess } from "./build.js";
import {
  FIELD_REF,
  PROFILE_FIELDS,
  type ProfileFieldName,
  valueSource,
  type WalkOp,
  type WalkSpec,
  walkSpecSchema,
} from "./spec.js";

export type Choice =
  | { to: "keep" }
  | { to: "fixed" }
  | { to: "ask" }
  | { to: "profile"; field: ProfileFieldName }
  | { to: "secret" };

const opAt = (spec: WalkSpec, g: Guess): WalkOp | undefined =>
  spec.screens.find((s) => s.name === g.screen)?.ops[g.op];

/** Where the value comes from now, in a word or two. */
export function sourceNow(spec: WalkSpec, g: Guess): string {
  const op = opAt(spec, g);
  if (op?.kind === "fill") {
    const src = valueSource(op.value);
    const v = op.value;
    const f = v.from === "plan" ? spec.fields.find((x) => x.key === v.field) : null;
    if (f?.default !== undefined && f.default !== g.typed) return `${src}, default ${f.default}`;
    if (f?.default !== undefined) return `${src}, default as typed`;
    return f ? `${src}, asked each run` : src;
  }
  if (op?.kind === "select") {
    const k = [...op.value.matchAll(FIELD_REF)][0]?.[1];
    return k ? `plan.${k}, asked each run` : "fixed";
  }
  return "?";
}

/** One review line: `label · typed · guess`. A secret's value is never shown. */
export const guessLine = (spec: WalkSpec, g: Guess): string =>
  `${g.label} · ${g.typed === null ? "•••" : JSON.stringify(g.typed)} · ${sourceNow(spec, g)} (${g.why})`;

/** The walk with one value's source changed. Fields and secrets nothing uses any more go. */
export function choose(spec: WalkSpec, g: Guess, c: Choice): WalkSpec {
  if (c.to === "keep") return spec;
  const w = structuredClone(spec) as WalkSpec;
  const screen = w.screens.find((s) => s.name === g.screen);
  const op = screen?.ops[g.op];
  if (!screen || !op || (op.kind !== "fill" && op.kind !== "select"))
    throw new Error(`no value at ${g.screen} op ${g.op + 1}`);
  const keyFor = (label: string, taken: readonly { key: string }[]) => {
    const c = camel(label) || "value";
    const base = /^[a-z]/.test(c) ? c : `v${c}`;
    let k = base;
    for (let n = 2; taken.some((x) => x.key === k); n++) k = `${base}${n}`;
    return k;
  };
  const was = op.kind === "fill" && op.value.from === "plan" ? op.value.field : null;
  if (op.kind === "select") {
    if (c.to === "fixed") op.value = g.typed ?? op.value;
    else if (c.to === "ask") {
      const key = keyFor(g.label, w.fields);
      w.fields.push({ key, label: g.label, example: g.typed });
      op.value = `{${key}}`;
    } else throw new Error(`${g.label} is a choice: fixed (f) or asked (a)`);
  } else if (c.to === "fixed") {
    if (g.typed === null) throw new Error(`${g.label} is a secret: its value is never kept`);
    op.value = { from: "literal", text: g.typed };
  } else if (c.to === "ask") {
    const key = was ?? keyFor(g.label, w.fields);
    const f = w.fields.find((x) => x.key === key);
    if (f) delete f.default;
    else w.fields.push({ key, label: g.label, example: g.typed });
    op.value = { from: "plan", field: key };
  } else if (c.to === "profile") op.value = { from: "profile", field: c.field };
  else {
    const key = keyFor(g.label, w.secrets);
    w.secrets.push({ key, label: g.label });
    op.value = { from: "secret", key };
  }
  // A click that followed the old field (a result picked by it) now follows what was typed.
  if (was && !(op.kind === "fill" && op.value.from === "plan" && op.value.field === was))
    for (const s of w.screens)
      for (const o of s.ops)
        if (o.kind === "click")
          for (const h of ["text", "name"] as const)
            if (o.hints[h] === `{${was}}` && g.typed !== null) o.hints[h] = g.typed;
  return prune(w);
}

/** Fields and secrets no op uses any more are dropped. */
function prune(w: WalkSpec): WalkSpec {
  const fields = new Set<string>();
  const secrets = new Set<string>();
  for (const s of w.screens)
    for (const op of s.ops) {
      const v = op.kind === "fill" ? op.value : op.kind === "upload" ? op.file : null;
      if (v?.from === "plan") fields.add(v.field);
      if (v?.from === "secret") secrets.add(v.key);
      const text =
        op.kind === "open"
          ? op.url.replace(/%7B/gi, "{").replace(/%7D/gi, "}")
          : op.kind === "click"
            ? `${op.hints.text ?? ""} ${op.hints.name ?? ""}`
            : op.kind === "select"
              ? op.value
              : "";
      for (const m of text.matchAll(FIELD_REF)) fields.add(m[1] as string);
    }
  return walkSpecSchema.parse({
    ...w,
    fields: w.fields.filter((f) => fields.has(f.key)),
    secrets: w.secrets.filter((s) => secrets.has(s.key)),
  });
}

/** What the review reads and writes: one line in, one line out. */
export interface ReviewIo {
  say(line: string): void;
  ask(prompt: string): Promise<string>;
}

export interface Reviewed {
  spec: WalkSpec;
  /** Values a person chose to keep fixed: packed even when they look personal. */
  allowed: string[];
}

export const REVIEW_KEYS =
  "Enter keeps the guess · f fixed · a ask each run · p profile · s secret";

/** One pass over every guess; `--yes` skips it and takes them all. */
export async function review(
  spec: WalkSpec,
  guesses: readonly Guess[],
  io: ReviewIo,
): Promise<Reviewed> {
  let w = spec;
  const allowed: string[] = [];
  if (!guesses.length) return { spec: w, allowed };
  io.say(REVIEW_KEYS);
  for (const g of guesses) {
    for (;;) {
      const key = (await io.ask(`  ${guessLine(w, g)}\n  > `)).trim().toLowerCase();
      try {
        if (key === "") break;
        if (key === "f") {
          w = choose(w, g, { to: "fixed" });
          if (g.typed !== null) allowed.push(g.typed);
        } else if (key === "a") w = choose(w, g, { to: "ask" });
        else if (key === "s") w = choose(w, g, { to: "secret" });
        else if (key === "p") {
          const field = (await io.ask(`  which profile field? ${PROFILE_FIELDS.join(", ")}\n  > `))
            .trim()
            .replace(/^profile\./, "");
          if (!(PROFILE_FIELDS as readonly string[]).includes(field)) {
            io.say(`  no profile field "${field}"`);
            continue;
          }
          w = choose(w, g, { to: "profile", field: field as ProfileFieldName });
        } else {
          io.say(`  ${REVIEW_KEYS}`);
          continue;
        }
        break;
      } catch (err) {
        io.say(`  ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { spec: w, allowed };
}

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
const PHONE = /^\+?[\d\s().-]{7,}$/;
const STREET =
  /^\d+\s+\S.*\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|cres|crescent|pl|place)\b\.?/i;

/** Whether a value reads as an email, a phone or a street address. */
export const looksPersonal = (v: string): boolean =>
  EMAIL.test(v) || (PHONE.test(v.trim()) && v.replace(/\D/g, "").length >= 7) || STREET.test(v);

/** Fixed text, defaults and examples in a walk that look personal: `where: value`. */
export function personalValues(w: WalkSpec): { where: string; value: string }[] {
  const out: { where: string; value: string }[] = [];
  for (const f of w.fields)
    for (const v of [f.default, f.example])
      if (v && looksPersonal(v)) out.push({ where: `field ${f.key}`, value: v });
  for (const s of w.screens)
    for (const op of s.ops) {
      const v =
        op.kind === "fill" && op.value.from === "literal"
          ? op.value.text
          : op.kind === "select"
            ? op.value
            : op.kind === "open"
              ? op.url
              : null;
      if (v && looksPersonal(v)) out.push({ where: `${s.name}: ${op.kind}`, value: v });
    }
  return out;
}

/** A walk as a mod carries it: no run ids, no examples. */
export const forMod = (w: WalkSpec): WalkSpec =>
  walkSpecSchema.parse({
    ...w,
    from: [],
    fields: w.fields.map((f) => ({ ...f, example: null })),
  });

/**
 * `--mod <dir>`: the walk into `<dir>/walks/<site>/<name>.json`, listed in
 * `mod.json` with its hash, its hosts in domains, its gates. A new folder
 * becomes a new mod. Refused when a fixed value or default looks personal
 * and the review did not allow it. Publishing (a version bump, npm) stays a
 * person's step.
 */
export function packInto(
  dir: string,
  spec: WalkSpec,
  o: { allowed?: readonly string[]; version: string },
): { file: string; mod: Mod } {
  const w = forMod(spec);
  const site = baseSite(w.site);
  const allowed = new Set(o.allowed ?? []);
  const personal = personalValues(w).filter((p) => !allowed.has(p.value));
  if (personal.length)
    throw new Error(
      `not packed: ${personal.map((p) => p.where).join(", ")} look personal. Teach again and press a (ask each run) or p (profile) on them, or f to keep them fixed.`,
    );
  const path = `walks/${site}/${w.name}.json`;
  const body = `${JSON.stringify(w, null, 2)}\n`;
  const modFile = join(dir, "mod.json");
  const pkgFile = join(dir, "package.json");
  const was: Partial<Mod> = existsSync(modFile)
    ? (JSON.parse(readFileSync(modFile, "utf8")) as Mod)
    : {};
  const hosts = new Set(was.domains ?? []);
  for (const u of [
    w.start,
    ...w.screens.flatMap((s) => s.ops.map((op) => (op.kind === "open" ? op.url : null))),
  ])
    if (u) hosts.add(hostOf(u));
  const irreversible =
    w.irreversible ||
    w.screens.some((s) => s.ops.some((op) => op.kind === "click" && op.irreversible));
  const gates = new Set(was.gates ?? []);
  if (irreversible) gates.add("send");
  if (w.screens.some((s) => s.ops.some((op) => op.kind === "captcha"))) gates.add("human");
  const name = was.name ?? `autobrowse-mod-${site.replace(/[^a-z0-9-]/g, "-")}`;
  const mod = modSchema.parse({
    name,
    version: was.version ?? "0.1.0",
    // The packing version reads this walk's format; an older one may not (v2 walks need 0.4.0).
    autobrowse: `>=${o.version}`,
    description: was.description ?? `${site}: ${w.goal}`,
    sites: [...new Set([...(was.sites ?? []), site])],
    domains: [...hosts].filter(Boolean).sort(),
    gates: [...gates],
    credentials: was.credentials ?? [],
    irreversible: (was.irreversible ?? false) || irreversible,
    files: [
      ...(was.files ?? []).filter((f) => f.path !== path),
      { kind: "walk", path, sha256: sha256(body) },
    ],
  });
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), body);
  writeFileSync(modFile, `${JSON.stringify(mod, null, 2)}\n`);
  const pkg = existsSync(pkgFile)
    ? (JSON.parse(readFileSync(pkgFile, "utf8")) as Record<string, unknown>)
    : {
        name,
        version: mod.version,
        description: mod.description,
        keywords: [MOD_KEYWORD, ...mod.sites],
        files: ["mod.json", "walks"],
      };
  pkg.autobrowseMod = { sites: mod.sites, domains: mod.domains, gates: mod.gates, code: false };
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  // The same check an install runs: what this wrote is what a buyer gets.
  checkMod(dir, { version: o.version });
  return { file: join(dir, path), mod };
}
