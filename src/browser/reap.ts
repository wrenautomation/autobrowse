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
}

export interface Orphan {
  pid: number;
  profile: string;
}

/** Root browser processes (not helpers) on a profile under `profilesDir`, owned by init. */
export function orphanBrowsers(procs: Proc[], profilesDir: string, self = process.pid): Orphan[] {
  // In a container the worker can be init itself: ppid 1 is then our own live browser.
  if (self === 1) return [];
  const prefix = `--user-data-dir=${profilesDir.replace(/\/$/, "")}/`;
  const out: Orphan[] = [];
  for (const p of procs) {
    if (p.ppid !== 1 || p.command.includes("--type=")) continue;
    const at = p.command.indexOf(prefix);
    if (at < 0) continue;
    const dir = p.command.slice(at + "--user-data-dir=".length).split(" --")[0] ?? "";
    out.push({ pid: p.pid, profile: basename(dir.trim()) });
  }
  return out;
}

export async function listProcs(): Promise<Proc[]> {
  const { stdout } = await promisify(execFile)("ps", ["-axo", "pid=,ppid=,command="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const procs: Proc[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] ?? "" });
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
