/**
 * The shared library, install side (designs/2026-10-24-shared-library.md).
 * On by default: each run's trace is scrubbed on this machine (`share/scrub`)
 * and queued; `sendShared` uploads the queue to Wren's ingest. Off with
 * `autobrowse share off`, `AUTOBROWSE_SHARE=off` or `DO_NOT_TRACK=1`.
 * Never shared, whatever the switch: personal profiles, secret flows, the
 * person's own browser (the runner makes no trace for the last two), and
 * sites on the exclude list.
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isPersonalProfile } from "../browser/network.js";
import { type Known, knownFromTrace, ScrubLeak, scrubText, scrubTrace } from "./scrub.js";

export const SHARE_URL = "https://share.wrenautomation.com";

export const NOTICE = [
  "autobrowse shares scrubbed run traces with Wren to make flows better for everyone.",
  "  Sent: actions, page structure, page text with personal data masked, request paths.",
  "  Never sent: screenshots, typed values, passwords, cookies, headers, response bodies,",
  "  personal profiles, or sites you exclude (`autobrowse share exclude <site>`).",
  "  Stop: `autobrowse share off`, AUTOBROWSE_SHARE=off or DO_NOT_TRACK=1.",
].join("\n");

export interface ShareState {
  /** Random, made on the first run; names no person. */
  installId: string;
  off?: boolean;
  /** Sites (`linkedin`) or profiles (`linkedin@wren`) never shared. */
  exclude: string[];
  noticedAt?: string;
}

export const shareRoot = (env: NodeJS.ProcessEnv = process.env): string =>
  env.AUTOBROWSE_SHARE_DIR ||
  join(env.AUTOBROWSE_STATS_DIR || join(homedir(), ".config", "autobrowse"), "share");

export function readShare(root = shareRoot()): ShareState {
  const file = join(root, "state.json");
  if (existsSync(file)) {
    const s = JSON.parse(readFileSync(file, "utf8")) as Partial<ShareState>;
    if (typeof s.installId === "string")
      return { ...s, installId: s.installId, exclude: s.exclude ?? [] };
  }
  const fresh: ShareState = { installId: randomUUID(), exclude: [] };
  writeShare(fresh, root);
  return fresh;
}

export function writeShare(s: ShareState, root = shareRoot()): void {
  mkdirSync(root, { recursive: true });
  const tmp = join(root, `state.json.${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, join(root, "state.json"));
}

/** Why sharing is off here, or null when it is on. */
export function shareOff(
  env: NodeJS.ProcessEnv = process.env,
  root = shareRoot(env),
): string | null {
  if (/^(off|0|false|no)$/i.test(env.AUTOBROWSE_SHARE ?? "")) return "AUTOBROWSE_SHARE=off";
  if (/^(1|true|yes)$/i.test(env.DO_NOT_TRACK ?? "")) return "DO_NOT_TRACK";
  if (readShare(root).off) return "autobrowse share off";
  return null;
}

/** The notice, once per install, before the first share. */
export function noticeOnce(print: (s: string) => void, root = shareRoot()): void {
  const s = readShare(root);
  if (s.noticedAt || s.off) return;
  print(NOTICE);
  writeShare({ ...s, noticedAt: new Date().toISOString() }, root);
}

/** `x@wren` is excluded by `x` or by `x@wren`. */
export function excluded(site: string, s: ShareState): boolean {
  const base = site.split("@")[0] ?? site;
  return isPersonalProfile(site) || s.exclude.includes(site) || s.exclude.includes(base);
}

/** Personal values beyond what the run typed (the profile's name, email, address): set at boot. */
let moreKnown: (() => Promise<Known[]>) | null = null;
export function setKnownSource(f: (() => Promise<Known[]>) | null): void {
  let cached: Promise<Known[]> | null = null;
  moreKnown = f && (() => (cached ??= f().catch(() => [])));
}

export type ShareResult = "queued" | "off" | "excluded" | "leak" | "error";

const slug = (s: string) =>
  s
    .replace(/@.*$/, "")
    .replace(/[^a-z0-9-]+/gi, "-")
    .slice(0, 60);

/**
 * Scrub a raw trace zip and queue it. The raw zip is the caller's: it stays
 * where it is. Never throws: sharing never fails a run.
 */
export async function shareTrace(
  rawZip: string,
  meta: { site: string; flow: string; outcome: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ShareResult> {
  try {
    const root = shareRoot(env);
    if (shareOff(env, root)) return "off";
    const state = readShare(root);
    if (excluded(meta.site, state)) return "excluded";
    const raw = readFileSync(rawZip);
    const known = [...knownFromTrace(raw), ...((await moreKnown?.()) ?? [])];
    let clean: Uint8Array;
    try {
      clean = scrubTrace(raw, known);
    } catch (err) {
      if (err instanceof ScrubLeak) return "leak";
      throw err;
    }
    noticeOnce((m) => process.stderr.write(`${m}\n`), root);
    const queue = join(root, "queue");
    mkdirSync(queue, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `${stamp}.${slug(meta.site)}.${slug(meta.flow)}.${slug(meta.outcome)}.zip`;
    writeFileSync(join(queue, `${name}.part`), clean);
    renameSync(join(queue, `${name}.part`), join(queue, name));
    return "queued";
  } catch {
    return "error";
  }
}

/** Queued files, oldest first: `.zip` traces, `.json` flow packs. */
export function queued(root = shareRoot()): { name: string; bytes: number }[] {
  const dir = join(root, "queue");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(zip|json)$/.test(f))
    .sort()
    .map((name) => ({ name, bytes: statSync(join(dir, name)).size }));
}

/**
 * Flow source files a pack carries: no dots in the stem, so tests (`index.test.ts`) and
 * local files (`.plan.json`, `.registry`) stay home. The proof goes in as its own field.
 */
const PACK_FILE = /^[A-Za-z0-9_-]+\.(ts|json)$/;

/** The proof fields a pack reads (structurally `Proof` from workflows/proof). */
export interface PackProof {
  at: string;
  status: string;
  steps: { name: string; status: string; detail: string }[];
  output: Record<string, string> | null;
}

/**
 * Queue a compiled workflow that just passed its proof, for the registry
 * (step 5). Source and proof go through the same scrub as a trace, with the
 * plan's values as known ones; read values stay home (only their keys go).
 * Never throws.
 */
export async function shareFlow(
  dir: string,
  proof: PackProof,
  plan: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ShareResult> {
  try {
    const root = shareRoot(env);
    if (shareOff(env, root)) return "off";
    if (proof.status !== "done") return "error";
    const outline = JSON.parse(readFileSync(join(dir, "outline.json"), "utf8")) as {
      name: string;
      site: string;
    };
    if (excluded(outline.site, readShare(root))) return "excluded";
    const known: Known[] = [
      ...Object.values(plan)
        .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
        .map((v) => ({ value: String(v), kind: "typed" })),
      ...Object.values(proof.output ?? {}).map((value) => ({ value, kind: "read" })),
      ...((await moreKnown?.()) ?? []),
    ];
    let pack: string;
    try {
      const files: Record<string, string> = {};
      for (const f of readdirSync(dir).filter((f) => PACK_FILE.test(f) && f !== "proof.json"))
        files[f] = scrubText(readFileSync(join(dir, f), "utf8"), known);
      pack = JSON.stringify({
        name: outline.name,
        site: outline.site,
        files,
        proof: {
          at: proof.at,
          status: proof.status,
          steps: proof.steps.map((x) => ({ ...x, detail: scrubText(x.detail, known) })),
          output: Object.keys(proof.output ?? {}),
        },
      });
    } catch (err) {
      if (err instanceof ScrubLeak) return "leak";
      throw err;
    }
    if (pack.length > 1024 * 1024) return "error";
    const queue = join(root, "queue");
    mkdirSync(queue, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `${stamp}.${slug(outline.name)}.flow.json`;
    writeFileSync(join(queue, `${name}.part`), pack);
    renameSync(join(queue, `${name}.part`), join(queue, name));
    return "queued";
  } catch {
    return "error";
  }
}

/** Biggest upload the ingest takes; a bigger file is dropped, never split. */
export const MAX_UPLOAD = 8 * 1024 * 1024;

/**
 * Upload the queue, oldest first, until `budgetMs` runs out. A file the
 * ingest takes (2xx) or refuses for good (4xx but 429) leaves the queue;
 * a 429, a 5xx or a network error stops the round and keeps the rest.
 */
export async function sendShared(
  o: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; budgetMs?: number } = {},
): Promise<{ sent: number; dropped: number; left: number; stopped?: string }> {
  const env = o.env ?? process.env;
  const root = shareRoot(env);
  const off = shareOff(env, root);
  const files = queued(root);
  if (off) return { sent: 0, dropped: 0, left: files.length, stopped: off };
  const { installId } = readShare(root);
  const base = (env.AUTOBROWSE_SHARE_URL || SHARE_URL).replace(/\/$/, "");
  const f = o.fetch ?? fetch;
  const until = Date.now() + (o.budgetMs ?? 30_000);
  let sent = 0;
  let dropped = 0;
  for (const [i, file] of files.entries()) {
    const path = join(root, "queue", file.name);
    if (Date.now() > until) return { sent, dropped, left: files.length - i, stopped: "time" };
    if (file.bytes > MAX_UPLOAD) {
      unlinkSync(path);
      dropped++;
      continue;
    }
    const kind = file.name.endsWith(".zip") ? "traces" : "flows";
    let status: number;
    try {
      const rsp = await f(`${base}/v1/${kind}/${encodeURIComponent(file.name)}`, {
        method: "PUT",
        headers: {
          "x-install": installId,
          "content-type": kind === "traces" ? "application/zip" : "application/json",
        },
        body: readFileSync(path),
        signal: AbortSignal.timeout(Math.max(1000, until - Date.now())),
      });
      status = rsp.status;
    } catch (err) {
      return { sent, dropped, left: files.length - i, stopped: (err as Error).name };
    }
    if (status === 429 || status >= 500)
      return { sent, dropped, left: files.length - i, stopped: `http ${status}` };
    unlinkSync(path);
    if (status < 300) sent++;
    else dropped++;
  }
  return { sent, dropped, left: 0 };
}
