/**
 * Fleet health, run by the desk hourly: a device silent over 24 h (no beat that recent, or none
 * at all and enrolled over 24 h ago) gets one post to the ops Discord lane; its return gets
 * another. `autotrack-health.json` in the state folder keeps who is silent, so nothing repeats.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { devices, type Iam } from "./enroll.js";
import { type BeatRead, readHeartbeat } from "./heartbeat.js";
import type { TrackStore } from "./store.js";

export const SILENT_MS = 24 * 3_600_000;

export interface HealthState {
  /** Devices last seen silent; a device missing here was fine (or new). */
  silent: string[];
}

export interface DeviceBeat {
  device: string;
  /** IAM user create date (ISO). */
  created: string;
  read: BeatRead;
}

export interface Transition {
  device: string;
  silent: boolean;
  text: string;
}

const utc = (iso: string) => `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;

function silentFor(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  return h < 72 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/**
 * Who went silent and who came back since `prev`. An unreadable beat says nothing either way, so
 * that device keeps its last state. A device no longer enrolled drops out.
 */
export function healthTransitions(
  prev: HealthState,
  rows: DeviceBeat[],
  now: Date,
): { next: HealthState; transitions: Transition[] } {
  const was = new Set(prev.silent);
  const silent: string[] = [];
  const transitions: Transition[] = [];
  for (const r of rows) {
    if (r.read.kind === "bad") {
      if (was.has(r.device)) silent.push(r.device);
      continue;
    }
    const beat = r.read.beat;
    const since = beat ? Date.parse(beat.at) : Date.parse(r.created);
    const quiet = now.getTime() - since > SILENT_MS;
    if (quiet) silent.push(r.device);
    if (quiet && !was.has(r.device))
      transitions.push({
        device: r.device,
        silent: true,
        text: beat
          ? `autotrack: ${r.device} silent ${silentFor(now.getTime() - since)} (last ${beat.version} at ${utc(beat.at)})`
          : `autotrack: ${r.device} silent, never beat (enrolled ${r.created.slice(0, 10)})`,
      });
    if (!quiet && was.has(r.device))
      transitions.push({
        device: r.device,
        silent: false,
        text: `autotrack: ${r.device} back${beat ? ` (${beat.version})` : ""}`,
      });
  }
  return { next: { silent }, transitions };
}

export async function readHealthState(file: string): Promise<HealthState> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Partial<HealthState>;
    return {
      silent: Array.isArray(raw.silent) ? raw.silent.filter((s) => typeof s === "string") : [],
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { silent: [] };
    throw err;
  }
}

async function writeHealthState(file: string, s: HealthState): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(s, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

/**
 * One check. A post that fails leaves that device's old state, so the next hour tries again.
 * A device whose heartbeat cannot be fetched (not a missing one) is skipped the same way.
 */
export async function checkHealth(o: {
  iam: Iam;
  store: TrackStore;
  file: string;
  post: (text: string) => Promise<void>;
  now?: Date;
  warn?: (msg: string) => void;
}): Promise<Transition[]> {
  const now = o.now ?? new Date();
  const prev = await readHealthState(o.file);
  const rows: DeviceBeat[] = [];
  for (const d of await devices(o.iam)) {
    try {
      rows.push({
        device: d.device,
        created: d.created,
        read: await readHeartbeat(o.store, d.device),
      });
    } catch (err) {
      o.warn?.(`${d.device}: ${err instanceof Error ? err.message : String(err)}`);
      rows.push({
        device: d.device,
        created: d.created,
        read: { kind: "bad", beat: null, reason: "fetch failed" },
      });
    }
  }
  const { next, transitions } = healthTransitions(prev, rows, now);
  const silent = new Set(next.silent);
  const sent: Transition[] = [];
  for (const t of transitions) {
    try {
      await o.post(t.text);
      sent.push(t);
    } catch (err) {
      o.warn?.(`post for ${t.device}: ${err instanceof Error ? err.message : String(err)}`);
      if (t.silent) silent.delete(t.device);
      else silent.add(t.device);
    }
  }
  await writeHealthState(o.file, { silent: [...silent].sort() });
  return sent;
}
