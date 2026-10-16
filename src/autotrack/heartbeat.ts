/**
 * A device's heartbeat: `<device>/heartbeat.json`, put by the recorder at start, before an update
 * restart and every 15 minutes (autotrack repo designs/2026-10-13-autotrack.md, "Heartbeat").
 * Two parts, so `parseKey` skips it and `list` never shows it. Only `v`, `version` and `at` are
 * required here; an older or newer recorder may leave the rest out.
 */
import { z } from "zod";
import type { TrackStore } from "./store.js";

export const heartbeatKey = (device: string) => `${device}/heartbeat.json`;

const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "not a date");

const heartbeatSchema = z.object({
  v: z.literal(1),
  version: z.string().min(1),
  at: iso,
  platform: z.string().optional(),
  arch: z.string().optional(),
  os: z.string().optional(),
  startedAt: iso.optional(),
  paused: z.string().nullish(),
  level: z.string().nullish(),
  memoryRestarts: z
    .object({
      count: z.number(),
      last: z.object({ helper: z.string(), why: z.string(), at: z.string() }).nullish(),
    })
    .nullish(),
  waiting: z.object({ segments: z.number().optional(), bytes: z.number().optional() }).optional(),
  ship: z
    .object({ at: z.string().nullish(), ok: z.boolean().nullish(), error: z.string().nullish() })
    .nullish(), // null until the first upload
  update: z
    .object({
      checkedAt: z.string().nullish(),
      latest: z.string().nullish(),
      state: z.string().nullish(),
      error: z.string().nullish(),
    })
    .nullish(),
});
export type Heartbeat = z.infer<typeof heartbeatSchema>;

/** `none`: the device never put one. `bad`: it is there but not a heartbeat this reads. */
export type BeatRead =
  | { kind: "ok"; beat: Heartbeat }
  | { kind: "none"; beat: null }
  | { kind: "bad"; beat: null; reason: string };

export function parseHeartbeat(body: Buffer | string): BeatRead {
  let raw: unknown;
  try {
    raw = JSON.parse(body.toString());
  } catch (err) {
    return { kind: "bad", beat: null, reason: `not JSON: ${(err as Error).message}` };
  }
  const r = heartbeatSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    return { kind: "bad", beat: null, reason: `${i?.path.join(".") || "body"}: ${i?.message}` };
  }
  return { kind: "ok", beat: r.data };
}

export async function readHeartbeat(store: TrackStore, device: string): Promise<BeatRead> {
  try {
    return parseHeartbeat(await store.get(heartbeatKey(device)));
  } catch (err) {
    if ((err as Error).name === "NoSuchKey") return { kind: "none", beat: null };
    throw err;
  }
}

/** "now", "12m ago", "5h ago", "3d ago". */
export function ago(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

/** A backlog worth a look: the recorder is not keeping up, or is not shipping at all. */
const BACKLOG_SEGMENTS = 10;
const BACKLOG_BYTES = 1e9;

const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

/** What is wrong with a device, from its last beat; empty when nothing is. */
export function problems(read: BeatRead): string[] {
  if (read.kind === "bad") return [`heartbeat unreadable (${read.reason})`];
  if (read.kind === "none") return [];
  const b = read.beat;
  const out: string[] = [];
  if (b.paused) out.push(`paused (${b.paused})`);
  if (b.ship?.error) out.push(`ship error: ${b.ship.error}`);
  if (b.update?.error) out.push(`update error: ${b.update.error}`);
  const mr = b.memoryRestarts;
  if (mr?.count && mr.last)
    out.push(`helper memory restarts ${mr.count} (last ${mr.last.helper}: ${mr.last.why})`);
  const seg = b.waiting?.segments ?? 0;
  const bytes = b.waiting?.bytes ?? 0;
  if (seg >= BACKLOG_SEGMENTS || bytes >= BACKLOG_BYTES)
    out.push(`waiting ${seg} segments (${mb(bytes)})`);
  return out;
}

/** One `autotrack devices` line: the IAM columns, then version, last seen and problems. */
export function deviceLine(
  d: { device: string; created: string; keys: number },
  read: BeatRead,
  now: Date,
): string {
  const seen = read.beat ? ago(now.getTime() - Date.parse(read.beat.at)) : "never";
  const p = problems(read);
  return [
    d.device,
    d.created.slice(0, 10),
    `keys ${d.keys}`,
    read.beat ? `v${read.beat.version}` : "v-",
    `seen ${seen}`,
    ...(p.length ? [p.join("; ")] : []),
  ].join("  ");
}
