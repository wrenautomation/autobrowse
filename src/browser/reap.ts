/**
 * A browser whose owner died keeps running: a crashed CLI, a killed worker.
 * It holds its profile (the next launch into it fails) and memory. Such a
 * browser is an orphan: its root process was handed to init (ppid 1). This
 * finds the orphans on our own profiles and stops them. A browser whose
 * owner is alive is never touched, however old: the owner closes it (an
 * explore session closes itself when idle).
 */
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

export interface Proc {
  pid: number;
  ppid: number;
  command: string;
  /** Resident memory, KB. */
  rss?: number;
  /** Seconds since it started. */
  age?: number;
}

export interface Orphan {
  pid: number;
  profile: string;
}

/** Root browser processes (not helpers) on a profile under `profilesDir`, whoever owns them. */
export function browserRoots(procs: Proc[], profilesDir: string): Array<Proc & Orphan> {
  const prefix = `--user-data-dir=${profilesDir.replace(/\/$/, "")}/`;
  const out: Array<Proc & Orphan> = [];
  for (const p of procs) {
    if (p.command.includes("--type=")) continue;
    const at = p.command.indexOf(prefix);
    if (at < 0) continue;
    const dir = p.command.slice(at + "--user-data-dir=".length).split(" --")[0] ?? "";
    out.push({ ...p, profile: basename(dir.trim()) });
  }
  return out;
}

/** Root browser processes (not helpers) on a profile under `profilesDir`, owned by init. */
export function orphanBrowsers(procs: Proc[], profilesDir: string, self = process.pid): Orphan[] {
  // In a container the worker can be init itself: ppid 1 is then our own live browser.
  if (self === 1) return [];
  return browserRoots(procs, profilesDir)
    .filter((p) => p.ppid === 1)
    .map((p) => ({ pid: p.pid, profile: p.profile }));
}

/** `ps` etime, `[[dd-]hh:]mm:ss`, in seconds. */
export function etimeSeconds(etime: string): number {
  const [days, clock = ""] = etime.includes("-") ? etime.split("-") : ["0", etime];
  return clock.split(":").reduce((s, n) => s * 60 + Number(n), 0) + Number(days) * 86_400;
}

export async function listProcs(): Promise<Proc[]> {
  const { stdout } = await promisify(execFile)("ps", ["-axo", "pid=,ppid=,rss=,etime=,command="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const procs: Proc[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m)
      procs.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        rss: Number(m[3]),
        age: etimeSeconds(m[4] ?? "0"),
        command: m[5] ?? "",
      });
  }
  return procs;
}

/** Stop every orphan on our profiles; `dry` only names them. Never throws: a sweep is best effort. */
export async function reapOrphans(
  profilesDir: string,
  o: { dry?: boolean; procs?: () => Promise<Proc[]>; kill?: (pid: number) => void } = {},
): Promise<Orphan[]> {
  const procs = await (o.procs ?? listProcs)().catch(() => []);
  const orphans = orphanBrowsers(procs, profilesDir);
  if (o.dry) return orphans;
  const kill = o.kill ?? ((pid: number) => process.kill(pid, "SIGTERM"));
  return orphans.filter((x) => {
    try {
      kill(x.pid);
      return true;
    } catch {
      return false; // gone already
    }
  });
}

/** Temp dirs a file-handling step makes and removes; one a crash left behind is only ever seconds old when in use. */
export const TEMP_PREFIXES = ["run-files-", "upload-", "passwords-"] as const;

/**
 * Remove our temp dirs older than `olderThanMs` (a crash mid-upload leaves a
 * copy of the file; a crashed Passwords import leaves logins on disk).
 * Returns how many went. Never throws.
 */
export async function reapTempDirs(
  o: { dir?: string; olderThanMs?: number; now?: number } = {},
): Promise<number> {
  const { readdir, rm, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = o.dir ?? tmpdir();
  const cutoff = (o.now ?? Date.now()) - (o.olderThanMs ?? 60 * 60_000);
  let gone = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!TEMP_PREFIXES.some((p) => name.startsWith(p))) continue;
    const path = join(dir, name);
    const st = await stat(path).catch(() => null);
    if (!st?.isDirectory() || st.mtimeMs > cutoff) continue;
    await rm(path, { recursive: true, force: true }).then(
      () => gone++,
      () => {},
    );
  }
  return gone;
}
