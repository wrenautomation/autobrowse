/**
 * `mods add|list|remove`: fetch a mod (an npm name, a dir, a tarball), check
 * its hashes and permissions, then copy it under the owner's `mods/`. Nothing
 * is merged into the owner's own files; removing a mod removes its folder.
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { siteAllowsHost } from "../auth/login.js";
import { SITE_LOGINS } from "../auth/sites.js";
import { baseSite } from "../runs/log.js";
import { walkSpecSchema } from "../walks/spec.js";
import {
  hostOf,
  inDomains,
  KIND_DIRS,
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

/**
 * Read and check a mod in `dir`: its schema, version range, every file's
 * hash, and that each file stays inside the domains, gates and credentials
 * the mod declares. Returns the mod, or throws `ModRefused` with every reason.
 */
export function checkMod(dir: string, o: { version: string }): Mod {
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
    }
  }
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
      .join(", ")}; data only`,
  ];
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

/** Copy a checked mod's listed files (and nothing else) under `modsDir`; replaces an older install. */
export function installMod(dir: string, mod: Mod, modsDir: string, source: string): string {
  const dest = join(modsDir, modDirName(mod.name));
  const tmp = `${dest}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  for (const p of ["mod.json", ...mod.files.map((f) => f.path)]) {
    mkdirSync(dirname(join(tmp, p)), { recursive: true, mode: 0o700 });
    cpSync(join(dir, p), join(tmp, p));
  }
  writeFileSync(
    join(tmp, "installed.json"),
    `${JSON.stringify({ source, at: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
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
