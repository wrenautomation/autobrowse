/**
 * The registry gate (designs/2026-10-24-shared-library.md, step 5). Flow packs
 * that passed Presidio (`kept/flows/`) get a static check; a pass waits in
 * `gate/review/` for a person's yes; a yes becomes a merged PR to the public
 * registry, opened by this job with Wren's `gh`, never the sharer's.
 * The gate never runs a pack's code: it parses it.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { redactPii } from "../recorder/redact.js";
import { PACKAGE } from "../workflows/roots.js";
import type { ShareAdmin } from "./presidio.js";

const run = promisify(execFile);

export const REGISTRY = "wrenautomation/autobrowse-flows";
export const REGISTRY_RAW = `https://raw.githubusercontent.com/${REGISTRY}/main`;

export interface FlowPack {
  name: string;
  site: string;
  files: Record<string, string>;
  proof: {
    at: string;
    status: string;
    steps: { name: string; status: string; detail: string }[];
    output: string[];
  };
}

/** One registry entry in `index.json`. */
export interface RegistryEntry {
  name: string;
  site: string;
  description: string;
  files: string[];
  at: string;
}

/** In a flow's folder: it came from the registry. Beside it, `.plan.json` lets the desk re-prove it. */
export const REGISTRY_MARK = ".registry";
export const REPROOF_PLAN = ".plan.json";

export const FLOW_NAME = /^[a-z0-9][a-z0-9-]{0,79}$/;
const FILE = /^[A-Za-z0-9_-]+\.(ts|json)$/;
/** The import a clone renders; the registry stores the package name instead. */
const CLONE_LIB = "../../index.js";
/** Names a flow has no use for: they reach the machine, the network or code from strings. */
const BANNED = new Set([
  "process",
  "require",
  "eval",
  "Function",
  "globalThis",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "Deno",
  "Bun",
  "module",
  "exports",
  "__dirname",
  "__filename",
]);

/** A pack's files with the library imported by its package name. */
export function normalized(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([f, s]) => [
      f,
      f.endsWith(".ts") ? s.replaceAll(`"${CLONE_LIB}"`, `"${PACKAGE}"`) : s,
    ]),
  );
}

/** Why the source of one `.ts` file fails, read from its syntax tree. */
async function codeReasons(file: string, src: string, files: Record<string, string>) {
  const ts = (await import("typescript")).default;
  const out: string[] = [];
  const syntax = ts.transpileModule(src, {
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).diagnostics;
  if (syntax?.length) out.push(`${file}: does not parse`);
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
  const allowed = (spec: string) =>
    spec === "zod" ||
    spec === PACKAGE ||
    spec === CLONE_LIB ||
    (/^\.\/[A-Za-z0-9_-]+\.js$/.test(spec) && `${spec.slice(2, -3)}.ts` in files);
  const visit = (n: import("typescript").Node): void => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier) &&
      !allowed(n.moduleSpecifier.text)
    )
      out.push(`${file}: imports ${n.moduleSpecifier.text}`);
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword)
      out.push(`${file}: dynamic import`);
    if (ts.isMetaProperty(n)) out.push(`${file}: import.meta`);
    if (ts.isIdentifier(n) && BANNED.has(n.text)) {
      const p = n.parent;
      const isKey =
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isPropertyAssignment(p) && p.name === n) ||
        (ts.isPropertySignature(p) && p.name === n);
      if (!isKey) out.push(`${file}: uses ${n.text}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** gitleaks over the files in a temp folder; the finding count only. */
async function leaks(files: Record<string, string>): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  try {
    await mkdir(join(dir, "src"));
    for (const [f, s] of Object.entries(files)) await writeFile(join(dir, "src", f), s);
    const report = join(dir, "report.json");
    await run("gitleaks", [
      "dir",
      join(dir, "src"),
      "--no-banner",
      "--log-level",
      "error",
      "--exit-code",
      "0",
      "--report-format",
      "json",
      "--report-path",
      report,
    ]);
    return (JSON.parse(readFileSync(report, "utf8")) as unknown[]).length;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every reason the pack fails the static check; empty = it passed. */
export async function checkPack(raw: unknown): Promise<string[]> {
  const p = raw as Partial<FlowPack>;
  if (typeof p?.name !== "string" || !FLOW_NAME.test(p.name)) return ["name"];
  if (typeof p.site !== "string" || !p.site) return ["site"];
  if (!p.files || typeof p.files !== "object") return ["files"];
  const files = p.files;
  const out: string[] = [];
  for (const [f, s] of Object.entries(files))
    if (!FILE.test(f) || typeof s !== "string") out.push(`file ${f}`);
  if (out.length) return out;
  if (!("index.ts" in files)) out.push("no index.ts");
  if ("outline.json" in files)
    try {
      const outline = JSON.parse(files["outline.json"] ?? "") as { name?: string };
      if (outline.name !== p.name) out.push("outline name");
    } catch {
      out.push("outline.json does not parse");
    }
  if (p.proof?.status !== "done") out.push("proof did not pass");
  for (const [f, s] of Object.entries(files)) {
    if (redactPii(s) !== s) out.push(`${f}: personal data`);
    if (f.endsWith(".ts")) out.push(...(await codeReasons(f, s, files)));
  }
  if (!out.length && (await leaks(files))) out.push("gitleaks");
  return [...new Set(out)];
}

/** A pack's review id: its name and the hash of its files. */
export const packId = (p: FlowPack): string =>
  `${p.name}-${createHash("sha256")
    .update(JSON.stringify(normalized(p.files)))
    .digest("hex")
    .slice(0, 8)}`;

export interface Held {
  id: string;
  pack: FlowPack;
  reasons: string[];
  at: string;
}

/**
 * Check every pack in `kept/flows/`: a pass waits in `gate/review/<id>.json`,
 * a fail goes to `gate/refused/`. A pack already seen (same id) only leaves
 * `kept/`. The pack never runs here.
 */
export async function gateShared(
  admin: ShareAdmin,
  now = () => new Date(),
): Promise<{ review: number; refused: number; seen: number }> {
  const seen = new Set(
    (await admin.list("gate/")).map((o) =>
      o.key
        .split("/")
        .at(-1)
        ?.replace(/\.json$/, ""),
    ),
  );
  const r = { review: 0, refused: 0, seen: 0 };
  for (const { key } of await admin.list("kept/flows/")) {
    let pack: FlowPack;
    try {
      pack = JSON.parse(new TextDecoder().decode(await admin.get(key))) as FlowPack;
    } catch {
      await admin.delete(key);
      r.refused++;
      continue;
    }
    const reasons = await checkPack(pack);
    const id = reasons.includes("name") ? `bad-${Date.now()}` : packId(pack);
    if (seen.has(id)) r.seen++;
    else {
      const held: Held = { id, pack, reasons, at: now().toISOString() };
      await admin.put(
        `gate/${reasons.length ? "refused" : "review"}/${id}.json`,
        JSON.stringify(held),
      );
      seen.add(id);
      if (reasons.length) r.refused++;
      else r.review++;
    }
    await admin.delete(key);
  }
  return r;
}

export async function heldPacks(admin: ShareAdmin, state = "review"): Promise<Held[]> {
  const out: Held[] = [];
  for (const { key } of await admin.list(`gate/${state}/`))
    out.push(JSON.parse(new TextDecoder().decode(await admin.get(key))) as Held);
  return out;
}

const getHeld = async (admin: ShareAdmin, id: string): Promise<Held> =>
  JSON.parse(new TextDecoder().decode(await admin.get(`gate/review/${id}.json`))) as Held;

/** A person's no: the pack moves to `gate/refused/` with the reason. */
export async function refusePack(admin: ShareAdmin, id: string, why: string): Promise<void> {
  const held = await getHeld(admin, id);
  await admin.put(
    `gate/refused/${id}.json`,
    JSON.stringify({ ...held, reasons: [`refused: ${why}`] }),
  );
  await admin.delete(`gate/review/${id}.json`);
}

type Sh = (cmd: string, args: string[], cwd?: string) => Promise<string>;
const sh: Sh = async (cmd, args, cwd) =>
  (await run(cmd, args, { ...(cwd ? { cwd } : {}), maxBuffer: 16 * 1024 * 1024 })).stdout;

/**
 * A person's yes: check again, write `flows/<name>/` and the index entry in a
 * clone of the registry, open the PR and merge it (the yes is the review).
 * Returns the PR URL.
 */
export async function approvePack(admin: ShareAdmin, id: string, exec: Sh = sh): Promise<string> {
  const held = await getHeld(admin, id);
  const reasons = await checkPack(held.pack);
  if (reasons.length) throw new Error(`check failed: ${reasons.join(", ")}`);
  const { pack } = held;
  const dir = mkdtempSync(join(tmpdir(), "registry-"));
  try {
    await exec("gh", ["repo", "clone", REGISTRY, dir, "--", "--depth", "1", "-q"]);
    const branch = `flow/${id}`;
    await exec("git", ["checkout", "-q", "-b", branch], dir);
    const flowDir = join(dir, "flows", pack.name);
    rmSync(flowDir, { recursive: true, force: true });
    await mkdir(flowDir, { recursive: true });
    const files = normalized(pack.files);
    for (const [f, s] of Object.entries(files)) writeFileSync(join(flowDir, f), s);
    const { output: _keys, ...proof } = pack.proof;
    writeFileSync(join(flowDir, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
    const indexFile = join(dir, "index.json");
    const index = JSON.parse(readFileSync(indexFile, "utf8")) as { flows: RegistryEntry[] };
    const outline = JSON.parse(files["outline.json"] ?? "{}") as { description?: string };
    const entry: RegistryEntry = {
      name: pack.name,
      site: pack.site,
      description: outline.description ?? "",
      files: [...Object.keys(files), "proof.json"].sort(),
      at: pack.proof.at,
    };
    index.flows = [...index.flows.filter((e) => e.name !== pack.name), entry].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);
    await exec("git", ["add", "-A"], dir);
    const msg = `${pack.name}: ${entry.description || pack.site}`;
    await exec("git", ["commit", "-q", "-m", msg], dir);
    await exec("git", ["push", "-q", "-u", "origin", branch], dir);
    const url = (
      await exec(
        "gh",
        [
          "pr",
          "create",
          "--repo",
          REGISTRY,
          "--head",
          branch,
          "--title",
          msg,
          "--body",
          `Shared by an autobrowse install; static check passed; approved at Wren (${id}).`,
        ],
        dir,
      )
    ).trim();
    await exec("gh", ["pr", "merge", url, "--squash", "--delete-branch"], dir);
    await admin.put(`gate/approved/${id}.json`, JSON.stringify({ ...held, pr: url }));
    await admin.delete(`gate/review/${id}.json`);
    return url;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `autobrowse workflows add <name>`: copy one flow from the registry into this
 * install's workflows folder, the library import set for where it lands.
 */
export async function addFlow(
  name: string,
  o: { root: string; lib: string; force?: boolean; fetch?: typeof fetch },
): Promise<string[]> {
  if (!FLOW_NAME.test(name)) throw new Error(`not a flow name: ${name}`);
  const f = o.fetch ?? fetch;
  const get = async (path: string) => {
    const rsp = await f(`${REGISTRY_RAW}/${path}`);
    if (!rsp.ok) throw new Error(`registry ${path}: ${rsp.status}`);
    return rsp.text();
  };
  const index = JSON.parse(await get("index.json")) as { flows: RegistryEntry[] };
  const entry = index.flows.find((e) => e.name === name);
  if (!entry)
    throw new Error(
      `no flow ${name} in the registry; there are: ${index.flows.map((e) => e.name).join(", ") || "none yet"}`,
    );
  const dir = join(o.root, name);
  if (!o.force && existsSync(dir)) throw new Error(`${dir} exists; pass --force to replace it`);
  const files: Record<string, string> = {};
  for (const file of entry.files) {
    if (!FILE.test(file)) throw new Error(`registry file name: ${file}`);
    const body = await get(`flows/${name}/${file}`);
    files[file] = file.endsWith(".ts") ? body.replaceAll(`"${PACKAGE}"`, `"${o.lib}"`) : body;
  }
  rmSync(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [file, body] of Object.entries(files)) await writeFile(join(dir, file), body);
  await writeFile(
    join(dir, REGISTRY_MARK),
    `${JSON.stringify({ from: REGISTRY, at: entry.at })}\n`,
  );
  return Object.keys(files);
}

/**
 * The nightly re-proof: every registry flow here with a `.plan.json` runs its
 * proof (gates declined, so nothing irreversible). A failure opens one issue
 * in the registry, or leaves the open one.
 */
export async function reproofRegistry(
  root: string,
  prove: (name: string, plan: Record<string, unknown>) => Promise<{ status: string }>,
  exec: Sh = sh,
): Promise<{ proven: number; broken: string[] }> {
  const { readdirSync } = await import("node:fs");
  const out = { proven: 0, broken: [] as string[] };
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!existsSync(join(dir, REGISTRY_MARK)) || !existsSync(join(dir, REPROOF_PLAN))) continue;
    const plan = JSON.parse(readFileSync(join(dir, REPROOF_PLAN), "utf8")) as Record<
      string,
      unknown
    >;
    const proof = await prove(name, plan).catch((err: Error) => ({
      status: `error ${err.message}`,
    }));
    if (proof.status === "done") {
      out.proven++;
      continue;
    }
    out.broken.push(name);
    const title = `broken: ${name}`;
    const open = await exec("gh", [
      "issue",
      "list",
      "--repo",
      REGISTRY,
      "--state",
      "open",
      "--search",
      `"${title}" in:title`,
      "--json",
      "number",
    ]);
    if ((JSON.parse(open || "[]") as unknown[]).length) continue;
    await exec("gh", [
      "issue",
      "create",
      "--repo",
      REGISTRY,
      "--title",
      title,
      "--body",
      `The nightly re-proof did not pass (${proof.status.split(" ")[0]}).`,
    ]);
  }
  return out;
}
