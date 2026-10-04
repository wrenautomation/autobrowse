/**
 * `mods search|add|list|remove`: fetch a mod (an npm name, a dir, a
 * tarball), check its hashes and permissions, then copy it under the owner's
 * `mods/`. Nothing is merged into the owner's own files; removing a mod
 * removes its folder. Code kinds need `--trust` and pass `checkCompiled`.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { siteAllowsHost } from "../auth/login.js";
import { SITE_LOGINS } from "../auth/sites.js";
import { checkCompiled } from "../compiler/check.js";
import { baseSite } from "../runs/log.js";
import { walkFlowName } from "../walks/flow.js";
import { walkSpecSchema } from "../walks/spec.js";
import { dataLoginSchema, loginProblems } from "./login.js";
import {
  CODE_KINDS,
  hostOf,
  inDomains,
  installedMods,
  KIND_DIRS,
  MOD_KEYWORD,
  MOD_NAME,
  type Mod,
  modDirName,
  modFixSchema,
  modSchema,
  modScreenSchema,
} from "./mod.js";

const run = promisify(execFile);

export const sha256 = (buf: Buffer | string): string =>
  createHash("sha256").update(buf).digest("hex");

/** This autobrowse's version, from its package.json. */
export const autobrowseVersion = (): string =>
  (
    JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version: string;
    }
  ).version;

/** `1.2.3` ≥ `1.2.0`. */
function atLeast(version: string, min: string): boolean {
  const a = version.split(/[.-]/).map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/** Whose a walk's secret is: `google.password` is google's, a bare `password` the walk's own site's. */
const secretSite = (key: string, site: string) =>
  key.includes(".") ? key.slice(0, key.lastIndexOf(".")) : site;

/** A refused mod: every reason, not just the first. */
export class ModRefused extends Error {
  constructor(
    name: string,
    readonly reasons: string[],
  ) {
    super(`${name}: refused\n  ${reasons.join("\n  ")}`);
    this.name = "ModRefused";
  }
}

/** A mod that ships code (a compiled workflow): runs only when added with `--trust`. */
export const hasCode = (mod: Mod): boolean => mod.files.some((f) => CODE_KINDS.has(f.kind));

/**
 * Read and check a mod in `dir`: its schema, version range, every file's
 * hash, and that each file stays inside the domains, gates and credentials
 * the mod declares. Code needs `trust`. Returns the mod, or throws
 * `ModRefused` with every reason.
 */
export function checkMod(dir: string, o: { version: string; trust?: boolean }): Mod {
  const raw = JSON.parse(readFileSync(join(dir, "mod.json"), "utf8")) as unknown;
  const parsed = modSchema.safeParse(raw);
  if (!parsed.success)
    throw new ModRefused(
      String((raw as { name?: unknown }).name ?? dir),
      parsed.error.issues.map((i) => `mod.json ${i.path.join(".")}: ${i.message}`),
    );
  const mod = parsed.data;
  const bad: string[] = [];
  const min = mod.autobrowse.slice(2);
  if (!atLeast(o.version, min))
    bad.push(`needs autobrowse ${mod.autobrowse}, this is ${o.version}`);
  const host = (where: string, url: string) => {
    if (!inDomains(hostOf(url), mod.domains))
      bad.push(`${where}: ${hostOf(url)} is outside domains ${mod.domains.join(", ")}`);
  };
  if (hasCode(mod) && !o.trust)
    bad.push("ships code (a workflow): add it with --trust, only if you trust its author");
  const credSites = new Set(mod.credentials.map((c) => c.split(":")[0] as string));
  const root = resolve(dir) + sep;
  for (const f of mod.files) {
    const file = resolve(dir, f.path);
    if (!file.startsWith(root) || !existsSync(file) || lstatSync(file).isSymbolicLink()) {
      bad.push(`${f.path}: missing, or not a plain file inside the mod`);
      continue;
    }
    const body = readFileSync(file);
    if (sha256(body) !== f.sha256) {
      bad.push(`${f.path}: sha256 does not match mod.json`);
      continue;
    }
    if (CODE_KINDS.has(f.kind)) continue;
    let data: unknown;
    try {
      data = JSON.parse(body.toString("utf8"));
    } catch {
      bad.push(`${f.path}: not JSON`);
      continue;
    }
    if (f.kind === "walk") {
      const w = walkSpecSchema.safeParse(data);
      if (!w.success) {
        bad.push(`${f.path}: ${w.error.issues[0]?.message ?? "not a walk"}`);
        continue;
      }
      const s = w.data;
      if (f.path !== `walks/${baseSite(s.site)}/${s.name}.json`)
        bad.push(`${f.path}: a walk lives at walks/<site>/<name>.json`);
      if (!mod.sites.includes(baseSite(s.site))) bad.push(`${f.path}: site ${s.site} not in sites`);
      if (s.start) host(f.path, s.start);
      const irreversible =
        s.irreversible ||
        s.screens.some((sc) => sc.ops.some((op) => op.kind === "click" && op.irreversible));
      if (irreversible && !mod.gates.some((g) => g === "send" || g === "purchase"))
        bad.push(`${f.path}: irreversible, but gates name neither send nor purchase`);
      if (irreversible && !mod.irreversible) bad.push(`${f.path}: irreversible, mod.json says not`);
      for (const k of s.secrets) {
        const site = secretSite(k.key, s.site);
        if (!credSites.has(baseSite(site)))
          bad.push(`${f.path}: secret ${k.key} needs a ${baseSite(site)} credential not listed`);
      }
      for (const sc of s.screens) {
        if (sc.url) host(`${f.path} ${sc.name}`, sc.url);
        for (const op of sc.ops) {
          if (op.kind === "open") host(`${f.path} ${sc.name}`, op.url);
          const v = op.kind === "fill" ? op.value : null;
          if (v?.from !== "secret") continue;
          // A secret goes only on a page the mod names, and only where its site's password may go.
          const owner = secretSite(v.key, s.site);
          if (!sc.url) bad.push(`${f.path} ${sc.name}: fills ${v.key} on any page`);
          else if (!siteAllowsHost(SITE_LOGINS, owner, hostOf(sc.url)))
            bad.push(`${f.path} ${sc.name}: types a ${owner} secret on ${hostOf(sc.url)}`);
        }
      }
    } else if (f.kind === "screens") {
      const rows = z.array(modScreenSchema).safeParse(data);
      if (!rows.success) bad.push(`${f.path}: ${rows.error.issues[0]?.message ?? "not screens"}`);
      else
        for (const r of rows.data) {
          if (!mod.sites.includes(r.site)) bad.push(`${f.path}: site ${r.site} not in sites`);
          host(f.path, r.url);
        }
    } else if (f.kind === "fixes") {
      const rows = z.array(modFixSchema).safeParse(data);
      if (!rows.success) bad.push(`${f.path}: ${rows.error.issues[0]?.message ?? "not fixes"}`);
      else
        for (const r of rows.data) {
          const site = r.flow.slice(0, r.flow.indexOf("/"));
          if (!mod.sites.includes(site)) bad.push(`${f.path}: flow ${r.flow} not in sites`);
          host(f.path, r.url);
        }
    } else if (f.kind === "login") {
      const l = dataLoginSchema.safeParse(data);
      if (!l.success) {
        bad.push(`${f.path}: ${l.error.issues[0]?.message ?? "not a login"}`);
        continue;
      }
      if (f.path !== `logins/${l.data.site}.json`)
        bad.push(`${f.path}: a login lives at logins/<site>.json`);
      for (const p of loginProblems(l.data, mod)) bad.push(`${f.path}: ${p}`);
      const who = l.data.oauth ? (l.data.oauth.provider ?? "google") : l.data.site;
      if (!credSites.has(who)) bad.push(`${f.path}: signs in as ${who}, a credential not listed`);
    }
  }
  for (const w of new Set(
    mod.files.filter((f) => f.kind === "workflow").map((f) => f.path.split("/")[1]),
  ))
    if (!mod.files.some((f) => f.path === `workflows/${w}/index.ts`))
      bad.push(`workflows/${w}: no index.ts listed`);
  if (bad.length) throw new ModRefused(mod.name, bad);
  return mod;
}

/** What a mod asks for, one line each: what `add` prints before it asks yes. */
export function permissionLines(mod: Mod): string[] {
  const count = (k: string) => mod.files.filter((f) => f.kind === k).length;
  return [
    `${mod.name}@${mod.version}: ${mod.description}`,
    `sites        ${mod.sites.join(", ")}`,
    `opens        ${mod.domains.join(", ")}`,
    `gates        ${mod.gates.join(", ") || "none"}${mod.irreversible ? " (irreversible acts: each run asks yes)" : ""}`,
    `credentials  ${mod.credentials.join(", ") || "none"} (your own, never shipped)`,
    `files        ${Object.keys(KIND_DIRS)
      .map((k) => `${count(k)} ${k}`)
      .join(", ")}; ${hasCode(mod) ? "CODE: runs with your access, --trust only" : "data only"}`,
  ];
}

export interface Found {
  name: string;
  version: string;
  description: string;
  sites: string[];
  domains: string[];
  gates: string[];
  code: boolean;
}

/** npm registry search on `keywords:autobrowse-mod`; each hit's `autobrowseMod` field read from its latest manifest. */
export async function searchMods(words: string, get: typeof fetch = fetch): Promise<Found[]> {
  const REGISTRY = "https://registry.npmjs.org";
  const json = async <T>(url: string): Promise<T> => {
    const res = await get(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`npm registry: ${res.status} on ${url}`);
    return (await res.json()) as T;
  };
  const text = encodeURIComponent(`keywords:${MOD_KEYWORD} ${words}`.trim());
  const { objects } = await json<{ objects: { package: { name: string; version: string } }[] }>(
    `${REGISTRY}/-/v1/search?text=${text}&size=25`,
  );
  return Promise.all(
    objects.map(async ({ package: p }) => {
      const m = await json<{
        description?: string;
        autobrowseMod?: Partial<Pick<Found, "sites" | "domains" | "gates" | "code">>;
      }>(`${REGISTRY}/${p.name.replace("/", "%2f")}/${p.version}`);
      return {
        name: p.name,
        version: p.version,
        description: m.description ?? "",
        sites: m.autobrowseMod?.sites ?? [],
        domains: m.autobrowseMod?.domains ?? [],
        gates: m.autobrowseMod?.gates ?? [],
        code: m.autobrowseMod?.code !== false,
      };
    }),
  );
}

/** A local copy of `source`: a dir as is, a tarball unpacked, else `npm pack` of a registry name. */
export async function fetchMod(source: string): Promise<{ dir: string; cleanup: () => void }> {
  if (existsSync(source) && lstatSync(source).isDirectory())
    return { dir: resolve(source), cleanup: () => undefined };
  const tmp = mkdtempSync(join(tmpdir(), "autobrowse-mod-"));
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  try {
    let tarball = source;
    if (!existsSync(source)) {
      // npm checks the tarball's integrity against the registry.
      const { stdout } = await run(
        "npm",
        ["pack", source, "--pack-destination", tmp, "--json", "--ignore-scripts"],
        { timeout: 120_000 },
      );
      const out = JSON.parse(stdout) as { filename: string }[];
      tarball = join(tmp, out[0]?.filename ?? "");
    }
    await run("tar", ["-xzf", resolve(tarball), "-C", tmp, "--no-same-owner"]);
    const dir = existsSync(join(tmp, "package", "mod.json")) ? join(tmp, "package") : tmp;
    if (!existsSync(join(dir, "mod.json"))) throw new Error(`${source}: no mod.json in it`);
    return { dir, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** This autobrowse's checkout: a code mod's workflows import its `src/index.ts` and its node_modules. */
const HOME = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Give a code mod what a workflow in `src/workflows/` has: `../../index.js`
 * (a shim onto this autobrowse), zod and the test runner (node_modules), an
 * ESM package.json and a tsconfig, then run `checkCompiled` on each
 * workflow. Null when it passes.
 * ponytail: needs a source checkout (tsc, vitest); an npm install of
 * autobrowse can't add a code mod.
 */
async function checkCode(dir: string, mod: Mod): Promise<string | null> {
  const lib = fileURLToPath(new URL("../index.js", import.meta.url));
  writeFileSync(join(dir, "index.ts"), `export * from ${JSON.stringify(lib)};\n`);
  symlinkSync(join(HOME, "node_modules"), join(dir, "node_modules"));
  writeFileSync(join(dir, "package.json"), '{ "type": "module", "private": true }\n');
  writeFileSync(
    join(dir, "tsconfig.json"),
    `${JSON.stringify({ extends: join(HOME, "tsconfig.json"), include: ["index.ts", "workflows"] }, null, 2)}\n`,
  );
  const names = new Set(
    mod.files.filter((f) => f.kind === "workflow").map((f) => f.path.split("/")[1] as string),
  );
  for (const w of names) {
    const why = await checkCompiled(join(dir, "workflows", w), { cwd: dir, timeoutMs: 300_000 });
    if (why) return `workflows/${w}: ${why}`;
  }
  return null;
}

/**
 * Copy a checked mod's listed files (and nothing else) under `modsDir`;
 * replaces an older install. A code mod (added with `trust`) must pass
 * `checkCompiled` in place first, or nothing is installed.
 */
export async function installMod(
  dir: string,
  mod: Mod,
  modsDir: string,
  source: string,
  o: { trust?: boolean } = {},
): Promise<string> {
  const dest = join(modsDir, modDirName(mod.name));
  const tmp = `${dest}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  try {
    for (const p of ["mod.json", ...mod.files.map((f) => f.path)]) {
      mkdirSync(dirname(join(tmp, p)), { recursive: true, mode: 0o700 });
      cpSync(join(dir, p), join(tmp, p));
    }
    const code = hasCode(mod);
    if (code && !o.trust) throw new ModRefused(mod.name, ["ships code: needs --trust"]);
    const why = code ? await checkCode(tmp, mod) : null;
    if (why) throw new ModRefused(mod.name, [`failed its checks, not added\n${why}`]);
    writeFileSync(
      join(tmp, "installed.json"),
      `${JSON.stringify({ source, at: new Date().toISOString(), trusted: code }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  rmSync(dest, { recursive: true, force: true });
  renameSync(tmp, dest);
  return dest;
}

/** Remove an installed mod by name. What it taught the owner's own files stays. */
export function removeMod(modsDir: string, name: string): boolean {
  if (!MOD_NAME.test(name)) throw new Error(`"${name}" is not a mod name`);
  const dir = join(modsDir, modDirName(name));
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** One installed mod as the Mods page shows it. */
export interface ModView {
  name: string;
  version: string;
  source: string;
  at: string;
  trusted: boolean;
  permissions: string[];
  /** Its walks' workflow names (`walk-<name>`): the runs that used them. */
  walks: string[];
  /** Its screens and fixes that worked and were kept in the owner's files. */
  kept: { screens: number; fixes: number };
}

export interface ModCheck {
  name: string;
  permissions: string[];
  /** What to add: a registry name pinned to the version checked. */
  source: string;
}

/** The Mods page's port: data mods only; code is added from the CLI, with `--trust`. */
export interface ModsPort {
  list(): ModView[];
  search(words: string): Promise<Found[]>;
  check(source: string): Promise<ModCheck>;
  add(source: string): Promise<string>;
  remove(name: string): boolean;
}

type Kept = () => readonly { from?: string }[];

export function modsPort(modsDir: string, own: { screens: Kept; fixes: Kept }): ModsPort {
  const checked = async <T>(source: string, then: (dir: string, mod: Mod) => Promise<T>) => {
    const { dir, cleanup } = await fetchMod(source);
    try {
      return await then(dir, checkMod(dir, { version: autobrowseVersion() }));
    } finally {
      cleanup();
    }
  };
  return {
    list() {
      const from = (rows: readonly { from?: string }[], name: string) =>
        rows.filter((r) => r.from === name).length;
      const [screens, fixes] = [own.screens(), own.fixes()];
      return installedMods(modsDir).map((m) => ({
        name: m.mod.name,
        version: m.mod.version,
        source: m.source,
        at: m.at,
        trusted: m.trusted,
        permissions: permissionLines(m.mod),
        walks: m.mod.files
          .filter((f) => f.kind === "walk")
          .map((f) => walkFlowName({ name: basename(f.path, ".json") })),
        kept: { screens: from(screens, m.mod.name), fixes: from(fixes, m.mod.name) },
      }));
    },
    search: (words) => searchMods(words),
    check: (source) =>
      checked(source, async (_dir, mod) => ({
        name: mod.name,
        permissions: permissionLines(mod),
        source: existsSync(source) ? source : `${mod.name}@${mod.version}`,
      })),
    add: (source) => checked(source, (dir, mod) => installMod(dir, mod, modsDir, source)),
    remove: (name) => removeMod(modsDir, name),
  };
}
