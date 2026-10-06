/**
 * Every browser of ours on this machine, who owns it, how old and how big,
 * and the explore servers beside them (`autobrowse browsers`). The doctor
 * reads `warnings` from the same view: a forgotten session, an orphan, a
 * profile two processes fight over. It reports; a person or agent decides.
 */
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { hostname, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import type { ExploreInfo } from "../explore/server.js";
import { browserRoots, listProcs, type Proc } from "./reap.js";

/** An explore server idle this long, not held, is forgotten. */
export const IDLE_WARN_MINUTES = 120;
/** A held session this old is likely forgotten too. */
export const HELD_WARN_HOURS = 12;
/** One browser (its whole process tree) over this. */
export const BROWSER_WARN_MB = 1536;
/** All our browsers over this share of the machine's RAM. */
export const RAM_WARN_SHARE = 0.5;
/** More explore servers than this at once. */
export const EXPLORERS_WARN = 4;

/** `desk`, `worker`, `explore:<port>`, `agent:<port>`, `teach:<port>`, `cli`, `orphan`, or `other` (launched by none of ours). */
export type Owner = string;

export interface BrowserRow {
  pid: number;
  owner: Owner;
  profile: string;
  /** Seconds. */
  age: number;
  /** RSS of the process tree. */
  mb: number;
}

export interface ExplorerRow extends ExploreInfo {
  idleMinutes: number;
}

/** A profile whose `SingletonLock` names a live browser that is none of the rows. */
export interface Stranger {
  profile: string;
  pid: number;
}

export interface BrowsersView {
  browsers: BrowserRow[];
  explorers: ExplorerRow[];
  strangers: Stranger[];
  totalMb: number;
  ramMb: number;
}

const explorerOwner = (e: ExploreInfo): Owner =>
  `${e.driver === "person" ? "teach" : e.driver.startsWith("agent") ? "agent" : "explore"}:${e.port}`;

/** Who launched the browser `pid`: the first ancestor that is ours, by explore info or command line. */
export function ownerOf(
  pid: number,
  profile: string,
  procs: Proc[],
  explorers: ExploreInfo[],
): Owner {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const root = byPid.get(pid);
  if (!root) return "gone";
  for (let p = byPid.get(root.ppid), hops = 0; p && hops < 8; p = byPid.get(p.ppid), hops++) {
    const ex = explorers.find(
      (e) => e.pid === p?.pid && (profile === e.site || profile.startsWith(`${e.site}@`)),
    );
    if (ex) return explorerOwner(ex);
    if (/app\/desk\.[jt]s\b/.test(p.command)) return "desk";
    if (/app\/main\.[jt]s\b/.test(p.command)) return "worker";
    if (/app\/cli\.[jt]s\b|\/autobrowse(\s|$)/.test(p.command)) return "cli";
  }
  // Checked last: in a container the worker is init itself.
  return root.ppid === 1 ? "orphan" : "other";
}

/** The explore servers whose process still lives, from their info files. */
export function readExplorers(
  procs: Proc[],
  dir = join(tmpdir(), "autobrowse"),
  now = Date.now(),
): ExplorerRow[] {
  const live = new Set(procs.map((p) => p.pid));
  const out: ExplorerRow[] = [];
  for (const name of safe(() => readdirSync(dir), [] as string[])) {
    if (!/^explore-\d+\.json$/.test(name)) continue;
    const file = join(dir, name);
    const info = safe(() => JSON.parse(readFileSync(file, "utf8")) as ExploreInfo, null);
    if (!info || !live.has(info.pid)) continue;
    const touched = safe(() => statSync(file).mtimeMs, now);
    out.push({ ...info, idleMinutes: Math.floor((now - touched) / 60_000) });
  }
  return out.sort((a, b) => a.port - b.port);
}

/** The live pid in a profile's `SingletonLock` (`<host>-<pid>`), when it is this host's. */
export function lockHolder(profileDir: string, alive = isAlive): number | null {
  const link = safe(() => readlinkSync(join(profileDir, "SingletonLock")), "");
  const m = /^(.*)-(\d+)$/.exec(link);
  if (!m || m[1] !== hostname()) return null;
  const pid = Number(m[2]);
  return alive(pid) ? pid : null;
}

/** Everything `browsers` and `doctor` show; never throws. */
export async function browsersNow(profilesDir: string, procs?: Proc[]): Promise<BrowsersView> {
  const ps = procs ?? (await listProcs().catch(() => []));
  return viewOf(ps, profilesDir, readExplorers(ps), totalmem() / 2 ** 20);
}

export function viewOf(
  procs: Proc[],
  profilesDir: string,
  explorers: ExplorerRow[],
  ramMb: number,
  locks = (profile: string) => lockHolder(join(profilesDir, profile)),
): BrowsersView {
  const kids = new Map<number, Proc[]>();
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const treeKb = (p: Proc): number =>
    (p.rss ?? 0) + (kids.get(p.pid) ?? []).reduce((s, k) => s + treeKb(k), 0);
  const browsers = browserRoots(procs, profilesDir).map((p) => ({
    pid: p.pid,
    owner: ownerOf(p.pid, p.profile, procs, explorers),
    profile: p.profile,
    age: p.age ?? 0,
    mb: Math.round(treeKb(p) / 1024),
  }));
  const ours = new Set(browsers.map((b) => b.pid));
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const strangers: Stranger[] = [];
  for (const profile of safe(() => readdirSync(profilesDir), [] as string[])) {
    const pid = locks(profile);
    // A pid reused by something that is no browser is a stale lock: Chrome clears it.
    if (pid && !ours.has(pid) && /chrom/i.test(byPid.get(pid)?.command ?? ""))
      strangers.push({ profile, pid });
  }
  return {
    browsers,
    explorers,
    strangers,
    totalMb: browsers.reduce((s, b) => s + b.mb, 0),
    ramMb: Math.round(ramMb),
  };
}

/** One line per thing wrong, each naming its fix. */
export function warnings(v: BrowsersView): string[] {
  const out: string[] = [];
  for (const b of v.browsers.filter((x) => x.owner === "orphan"))
    out.push(`orphan browser on ${b.profile} (pid ${b.pid}): autobrowse reap`);
  for (const e of v.explorers) {
    if (!e.held && e.idleMinutes >= IDLE_WARN_MINUTES)
      out.push(
        `explore ${e.port} (${e.site}) idle ${e.idleMinutes} min: autobrowse browsers stop ${e.port}`,
      );
    const hours = (Date.now() - Date.parse(e.startedAt)) / 3_600_000;
    if (e.held && hours >= HELD_WARN_HOURS)
      out.push(
        `explore ${e.port} (${e.site}) held ${Math.floor(hours)} h: stop it (autobrowse browsers stop ${e.port}) or say why it is still needed`,
      );
  }
  const byProfile = new Map<string, BrowserRow[]>();
  for (const b of v.browsers) byProfile.set(b.profile, [...(byProfile.get(b.profile) ?? []), b]);
  for (const [profile, rows] of byProfile)
    if (rows.length > 1)
      out.push(
        `profile ${profile} open twice: ${rows.map((b) => `pid ${b.pid} (${b.owner})`).join(", ")}; stop one`,
      );
  for (const s of v.strangers)
    out.push(`profile ${s.profile} is locked by pid ${s.pid}, not ours: close that Chrome`);
  for (const b of v.browsers.filter((x) => x.mb > BROWSER_WARN_MB))
    out.push(`${b.profile} (pid ${b.pid}, ${b.owner}) uses ${b.mb} MB: autobrowse browsers`);
  if (v.ramMb && v.totalMb > v.ramMb * RAM_WARN_SHARE)
    out.push(
      `browsers use ${v.totalMb} MB, ${Math.round((100 * v.totalMb) / v.ramMb)}% of RAM: autobrowse browsers`,
    );
  if (v.explorers.length > EXPLORERS_WARN)
    out.push(
      `${v.explorers.length} explore servers open: stop the idle ones (autobrowse browsers stop <port>)`,
    );
  return out;
}

/**
 * Before a launch into `profileDir`: a live browser holding it fails here
 * with who holds it, not later with Chrome's own error. `reaped` were just
 * told to stop and get a few seconds to let go.
 */
export async function assertProfileFree(
  profileDir: string,
  profile: string,
  reaped: number[] = [],
): Promise<void> {
  let pid = lockHolder(profileDir);
  for (let i = 0; pid && reaped.includes(pid) && i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    pid = lockHolder(profileDir);
  }
  if (!pid) return;
  const procs = await listProcs().catch(() => []);
  const holder = procs.find((p) => p.pid === pid);
  if (!holder || !/chrom/i.test(holder.command)) return; // a reused pid: the lock is stale
  throw new Error(
    `profile ${profile} is open in pid ${pid} (${ownerOf(pid, profile, procs, readExplorers(procs))})`,
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function safe<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback;
  }
}
