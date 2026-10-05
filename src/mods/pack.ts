/**
 * `mods pack`: a mod from the owner's own walks, screens, fixes and login. Scrubbed
 * before anything is written: no secret values, no addresses or usernames,
 * no query strings or fragments, no run ids, no example values. Whatever
 * still matches a stored credential value is refused. Publishing is a
 * person's `npm publish`, never this.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CredentialStore } from "credvault";
import type { z } from "zod";
import type { Fix } from "../browser/fixes.js";
import type { LearnedScreen } from "../browser/screens.js";
import { baseSite } from "../runs/log.js";
import { loadWalk, type WalkOp, type WalkSpec, walkFile } from "../walks/spec.js";
import { sha256 } from "./install.js";
import { type DataLogin, dataLoginSchema } from "./login.js";
import {
  hostOf,
  MOD_KEYWORD,
  type Mod,
  type ModKind,
  type modFixSchema,
  modSchema,
  type modScreenSchema,
} from "./mod.js";

/** What the scrubber knows of the owner, from their stored logins. Never written anywhere. */
export interface Scrub {
  /** Passwords, keys, codes: masked or dropped, and refused if any is left. */
  secrets: string[];
  /** Usernames and addresses: masked or dropped, and refused if any is left. */
  people: string[];
}

export interface Packed {
  dir: string;
  mod: Mod;
  kept: string[];
  dropped: string[];
}

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Values this short are words, not secrets: matching them would mangle every page. */
const MIN = 4;

class Scrubber {
  readonly dropped: string[] = [];
  private readonly people: RegExp[];
  private readonly secrets: string[];
  constructor(s: Scrub) {
    this.secrets = s.secrets.filter((v) => v.length >= MIN);
    this.people = s.people
      .filter((v) => v.length >= MIN)
      .map((v) => new RegExp(`(?<![\\w.-])${literal(v)}(?![\\w-])`, "gi"));
  }
  /** Whether a string carries anything personal. */
  dirty(s: string): boolean {
    EMAIL.lastIndex = 0;
    return (
      EMAIL.test(s) ||
      this.secrets.some((v) => s.includes(v)) ||
      this.people.some((r) => {
        r.lastIndex = 0;
        return r.test(s);
      })
    );
  }
  /** Prose: what is personal becomes a placeholder. */
  text(s: string, where: string): string {
    if (!this.dirty(s)) return s;
    let out = s.replace(EMAIL, "<email>");
    for (const v of this.secrets) out = out.split(v).join("<secret>");
    for (const r of this.people) out = out.replace(r, "<user>");
    this.dropped.push(`${where}: masked personal text`);
    return out;
  }
  /** No query, no fragment; a path segment that names a person becomes `*`. */
  url(u: string, where: string): string {
    const cut = u.replace(/[?#].*$/, "");
    if (cut !== u) this.dropped.push(`${where}: query or fragment`);
    const parts = cut.split("/");
    const clean = parts.map((p, i) => (i > 2 || !cut.includes("://") ? this.segment(p) : p));
    if (clean.join("/") !== cut) this.dropped.push(`${where}: a path segment naming an account`);
    return clean.join("/");
  }
  private segment(p: string): string {
    if (!p || p === "*") return p;
    return this.dirty(decodeURIComponentSafe(p)) ? "*" : p;
  }
  /** A hint's field that names a person or carries a secret is dropped; the rest still locate. */
  hints<H extends Record<string, unknown>>(h: H, where: string): H {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(h)) {
      if (typeof v === "string" && k === "href") out[k] = this.url(v, `${where} href`);
      else if (typeof v === "string" && this.dirty(v)) this.dropped.push(`${where}: hint ${k}`);
      else out[k] = v;
    }
    return out as H;
  }
  landmarks(ls: string[], where: string): string[] {
    const kept = ls.filter((l) => !this.dirty(l));
    if (kept.length < ls.length)
      this.dropped.push(`${where}: ${ls.length - kept.length} landmark(s)`);
    return kept;
  }
  /** Refuse output that still holds any stored value or address. */
  check(file: string, body: string): void {
    const hit =
      this.secrets.some((v) => body.includes(v)) ||
      this.people.some((r) => {
        r.lastIndex = 0;
        return r.test(body);
      });
    EMAIL.lastIndex = 0;
    if (hit || EMAIL.test(body))
      throw new Error(`pack refused: ${file} still matches a stored credential value or address`);
  }
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function scrubWalk(w: WalkSpec, x: Scrubber): WalkSpec {
  const at = `walk ${w.name}`;
  const fields = w.fields.map((f) => {
    if (f.example !== null) x.dropped.push(`${at}: example of ${f.key}`);
    const { default: d, ...rest } = f;
    if (d !== undefined && x.dirty(d)) x.dropped.push(`${at}: default of ${f.key}, naming you`);
    const keep = d !== undefined && !x.dirty(d) ? { default: d } : {};
    return { ...rest, ...keep, label: x.text(f.label, at), example: null };
  });
  if (w.from.length) x.dropped.push(`${at}: ${w.from.length} run id(s)`);
  let n = 0;
  const field = (label: string, where: string, why: string) => {
    n += 1;
    const key = `typed${n}`;
    fields.push({ key, label, example: null });
    x.dropped.push(`${where}: ${why}, now plan field ${key}`);
    return { from: "plan" as const, field: key };
  };
  const op = (o: WalkOp, where: string): WalkOp => {
    if (o.kind === "human") return { ...o, reason: x.text(o.reason, where) };
    const h = "hints" in o ? { hints: x.hints(o.hints, where) } : {};
    const goal = x.text(o.goal, where);
    if (o.kind === "open") return { ...o, goal, url: x.url(o.url, where) };
    if (o.kind === "fill" && o.value.from === "literal" && x.dirty(o.value.text))
      return { ...o, ...h, goal, value: field(goal, where, "a typed value naming you") };
    // A literal file is a path on the owner's disk.
    if (o.kind === "upload" && o.file.from === "literal")
      return { ...o, ...h, goal, file: field(goal, where, "a local file path") };
    if (o.kind === "select") return { ...o, ...h, goal, value: x.text(o.value, where) };
    return { ...o, ...h, goal } as WalkOp;
  };
  return {
    ...w,
    goal: x.text(w.goal, at),
    from: [],
    start: w.start ? x.url(w.start, at) : null,
    secrets: w.secrets.map((s) => ({ ...s, label: x.text(s.label, at) })),
    screens: w.screens.map((s) => {
      const where = `${at} ${s.name}`;
      return {
        ...s,
        looks: x.text(s.looks, where),
        url: s.url ? x.url(s.url, where) : null,
        landmarks: x.landmarks(s.landmarks, where),
        ops: s.ops.map((o) => op(o, where)),
      };
    }),
    fields,
  };
}

/**
 * Build a mod for `site` into `out`. Walks by name (the owner's own only),
 * plus the site's learned screens and kept fixes when given.
 */
/** A login: URLs lose queries; any field that names the owner is dropped (a required one refuses the pack). */
function scrubLogin(l: DataLogin, x: Scrubber): DataLogin {
  const walk = (v: unknown, where: string): unknown => {
    if (Array.isArray(v)) return v.map((e, i) => walk(e, `${where}.${i}`));
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, e] of Object.entries(v)) {
      if (typeof e === "string" && (k === "home" || k === "start"))
        out[k] = x.url(e, `${where}.${k}`);
      else if (typeof e === "string" && x.dirty(e)) x.dropped.push(`${where}.${k}`);
      else out[k] = walk(e, `${where}.${k}`);
    }
    return out;
  };
  const clean = dataLoginSchema.safeParse(walk(l, "login"));
  if (!clean.success)
    throw new Error(
      `pack refused: the login needs a field that names you (${x.dropped.join(", ")})`,
    );
  return clean.data;
}

export function packMod(o: {
  site: string;
  walksDir: string;
  walks: string[];
  screens?: LearnedScreen[];
  fixes?: Fix[];
  /** The owner's own `logins/<site>.json`. */
  login?: DataLogin;
  scrub: Scrub;
  out: string;
  /** This autobrowse's version: the mod needs at least it. */
  version: string;
  name?: string;
  description?: string;
}): Packed {
  const site = baseSite(o.site);
  const x = new Scrubber(o.scrub);
  const files: { kind: ModKind; path: string; body: string }[] = [];
  const kept: string[] = [];
  const add = (kind: ModKind, path: string, data: unknown) =>
    files.push({ kind, path, body: `${JSON.stringify(data, null, 2)}\n` });

  const walks: WalkSpec[] = [];
  for (const name of o.walks) {
    if (!existsSync(walkFile(o.walksDir, site, name)))
      throw new Error(`no walk ${site}/${name} of your own; see: autobrowse walks list`);
    const w = scrubWalk(loadWalk(o.walksDir, site, name) as WalkSpec, x);
    walks.push(w);
    add("walk", `walks/${site}/${w.name}.json`, w);
    kept.push(`walk ${site}/${w.name}: ${w.screens.length} screens`);
  }
  if (o.screens) {
    const rows: z.infer<typeof modScreenSchema>[] = o.screens
      .filter((r) => baseSite(r.site) === site)
      .map((r, i) => ({
        site,
        url: x.url(r.url, `screen ${i}`),
        landmarks: x.landmarks(r.landmarks, `screen ${i}`),
        ...(r.walk ? { walk: r.walk } : {}),
        ...(r.screen ? { screen: r.screen } : {}),
        ...(r.click ? { click: x.hints(r.click as Record<string, unknown>, `screen ${i}`) } : {}),
        reason: x.text(r.reason, `screen ${i}`),
      }))
      .filter((r) => r.landmarks.length >= 2);
    if (rows.length) {
      add("screens", `screens/${site}.json`, rows);
      kept.push(`${rows.length} learned screen(s)`);
    }
  }
  if (o.fixes) {
    const byFlow = new Map<string, z.infer<typeof modFixSchema>[]>();
    for (const [i, f] of o.fixes.filter((f) => f.flow.startsWith(`${site}/`)).entries()) {
      const where = `fix ${i}`;
      const row = {
        flow: f.flow,
        goal: x.text(f.goal, where),
        failed: x.hints(f.failed as Record<string, unknown>, `${where} failed`),
        hints: x.hints(f.hints as Record<string, unknown>, where),
        ...(f.detours?.length
          ? { detours: f.detours.map((d) => x.hints(d as Record<string, unknown>, where)) }
          : {}),
        reason: x.text(f.reason, where),
        url: x.url(f.url, where),
      };
      byFlow.set(f.flow, [...(byFlow.get(f.flow) ?? []), row]);
    }
    for (const [flow, rows] of byFlow) {
      add("fixes", `fixes/${flow}.json`, rows);
      kept.push(`${rows.length} fix(es) for ${flow}`);
    }
  }
  let login: DataLogin | null = null;
  if (o.login) {
    if (o.login.site !== site) throw new Error(`the login is for ${o.login.site}, not ${site}`);
    login = scrubLogin(o.login, x);
    add("login", `logins/${site}.json`, login);
    kept.push(
      `login ${site} (${login.form ? "form" : `oauth via ${login.oauth?.provider ?? "google"}`})`,
    );
  }
  if (!files.length) throw new Error(`nothing to pack for ${site}`);

  const hosts = new Set<string>();
  for (const w of walks) {
    if (w.start) hosts.add(hostOf(w.start));
    for (const s of w.screens) {
      if (s.url) hosts.add(hostOf(s.url));
      for (const op of s.ops) if (op.kind === "open") hosts.add(hostOf(op.url));
    }
  }
  for (const f of files)
    if (f.kind === "screens" || f.kind === "fixes")
      for (const r of JSON.parse(f.body) as { url: string }[]) hosts.add(hostOf(r.url));
  if (login)
    for (const h of [login.home, login.form?.start ?? login.oauth?.start ?? login.home])
      hosts.add(hostOf(h));
  for (const h of login?.origins ?? []) hosts.add(h);
  const irreversible = walks.some(
    (w) =>
      w.irreversible ||
      w.screens.some((s) => s.ops.some((op) => op.kind === "click" && op.irreversible)),
  );
  const credentials = new Set<string>();
  for (const w of walks)
    for (const s of w.secrets) {
      const who = s.key.includes(".") ? s.key.slice(0, s.key.lastIndexOf(".")) : w.site;
      const [base, label] = who.split("@") as [string, string | undefined];
      credentials.add(`${baseSite(base)}:${label ?? "main"}`);
    }
  if (login) credentials.add(`${login.oauth ? (login.oauth.provider ?? "google") : site}:main`);
  const gates = new Set<Mod["gates"][number]>();
  if (irreversible) gates.add("send");
  if (walks.some((w) => w.screens.some((s) => s.ops.some((op) => op.kind === "captcha"))))
    gates.add("human");

  const name = o.name ?? `autobrowse-mod-${site.replace(/[^a-z0-9-]/g, "-")}`;
  const mod = modSchema.parse({
    name,
    version: "0.1.0",
    autobrowse: `>=${o.version}`,
    description: x.text(
      o.description ?? `${site}: ${walks.map((w) => w.goal).join("; ") || "screens and fixes"}`,
      "description",
    ),
    sites: [site],
    domains: [...hosts].filter(Boolean).sort(),
    gates: [...gates],
    credentials: [...credentials].sort(),
    irreversible,
    files: files.map((f) => ({ kind: f.kind, path: f.path, sha256: sha256(f.body) })),
  });
  const modJson = `${JSON.stringify(mod, null, 2)}\n`;
  const pkg = `${JSON.stringify(
    {
      name,
      version: mod.version,
      description: mod.description,
      keywords: [MOD_KEYWORD, ...mod.sites],
      files: ["mod.json", ...new Set(files.map((f) => f.path.split("/")[0] as string))],
      autobrowseMod: { sites: mod.sites, domains: mod.domains, gates: mod.gates, code: false },
    },
    null,
    2,
  )}\n`;
  for (const f of files) x.check(f.path, f.body);
  x.check("mod.json", modJson);
  x.check("package.json", pkg);

  if (existsSync(o.out) && readdirSync(o.out).length && !existsSync(join(o.out, "mod.json")))
    throw new Error(`${o.out} is not empty and holds no mod: pick another --out`);
  rmSync(o.out, { recursive: true, force: true });
  for (const f of files) {
    mkdirSync(dirname(join(o.out, f.path)), { recursive: true });
    writeFileSync(join(o.out, f.path), f.body);
  }
  writeFileSync(join(o.out, "mod.json"), modJson);
  writeFileSync(join(o.out, "package.json"), pkg);
  return { dir: o.out, mod, kept, dropped: [...new Set(x.dropped)] };
}

/** What the scrubber needs from a credential store: every stored value, read once, kept in memory. */
export async function scrubFrom(store: CredentialStore): Promise<Scrub> {
  const secrets: string[] = [];
  const people: string[] = [];
  for (const key of await store.list()) {
    const c = await store.get(key);
    if (!c) continue;
    people.push(c.username, ...(c.codesInbox ? [c.codesInbox] : []));
    for (const v of [
      c.password,
      c.previousPassword,
      c.totpSecret,
      ...c.recoveryCodes,
      ...c.passkeys.flatMap((p) => [p.credentialId, p.privateKey, p.userHandle]),
    ])
      if (v) secrets.push(v);
  }
  return { secrets, people };
}
