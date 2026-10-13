/**
 * A track session → an autobrowse `Recording` of desktop acts, so teach and compile read what a
 * person did on their own machine. Downloads the events, the frames the recording points at and
 * every accessibility tree (`track/trees/<n>.json|txt`, named by `tree` and `treeFile` events).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { looksLikeSecretValue, REDACTED } from "../recorder/redact.js";
import { recordingDir, saveRecording } from "../recorder/store.js";
import type { Action, Recording } from "../recorder/types.js";
import { checkDevice } from "./code.js";
import { labelKey } from "./label.js";
import { parseKey, type TrackStore } from "./store.js";
import type { Event, Labels, SessionMeta } from "./types.js";

const SESSION = /^[0-9]{8}T[0-9]{6}-[0-9a-f]{4}$/;

/** Parse one segment's lines; a line cut short by a crash is dropped, not fatal. */
export function parseEvents(text: string): Event[] {
  const out: Event[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Event;
      if (typeof e?.kind === "string" && typeof e.t === "number") out.push(e);
    } catch {}
  }
  return out;
}

const MOD_ORDER = ["ctrl", "alt", "shift", "meta"] as const;
const MOD_NAME = { ctrl: "ctrl", alt: "alt", shift: "shift", meta: "cmd" } as const;

/** ["meta","shift"] + "4" → "shift+cmd+4", the combos `Desktop.key` takes. */
export function comboOf(key: string, mods: readonly string[]): string {
  const have = MOD_ORDER.filter((m) => mods.includes(m)).map((m) => MOD_NAME[m]);
  return [...have, key].join("+");
}

/**
 * Not converted, on purpose: `move` and `scroll` (no desktop op reads them, and a recording is
 * the chore, not the cursor path), `frame` (idle reading), `focus` (every act already names its
 * app), `pause`/`resume` (those mean a human/agent hand-off in a recording, not a tracker gap).
 * Clicks and drags the probe could not name an element for have nothing to address by, so they
 * become notes: the chore still reads in order.
 */
export function eventsToActions(
  events: readonly Event[],
  screenshotOf: (frame: number | undefined) => string | undefined,
  /** Why each act was done, by event `t`, from the offline labels (`autotrack label`). */
  intents?: ReadonlyMap<number, string>,
): Action[] {
  const out: Action[] = [];
  for (const e of events) {
    const shot = screenshotOf("after" in e ? e.after : undefined);
    const intent = intents?.get(e.t);
    const base = {
      t: e.t,
      url: "",
      ...(shot ? { screenshot: shot } : {}),
      ...(intent ? { intent } : {}),
    };
    const where = e.app?.name ? ` in ${e.app.name}` : "";
    switch (e.kind) {
      case "click": {
        const el = e.element;
        if (e.button === "left" && el?.name) {
          const op = {
            op: "click" as const,
            ...(e.app?.name ? { app: e.app.name } : {}),
            ...(el.role ? { role: el.role } : {}),
            name: el.name,
          };
          const times = Math.min(Math.max(Math.round(e.count) || 1, 1), 3);
          for (let i = 0; i < times; i++)
            out.push({ ...base, kind: "desktop", op, redacted: false });
        } else {
          const what = el?.name ? `${el.role} "${el.name}"` : `(${e.x}, ${e.y}), no element`;
          out.push({ ...base, kind: "note", text: `${e.button} click on ${what}${where}` });
        }
        break;
      }
      case "drag":
        out.push({
          ...base,
          kind: "note",
          text: `drag (${e.x0}, ${e.y0}) to (${e.x}, ${e.y})${e.element?.name ? ` from ${e.element.role} "${e.element.name}"` : ""}${where}`,
        });
        break;
      case "text": {
        const secret = e.redacted || looksLikeSecretValue(e.text);
        if (!secret && !e.text) break;
        out.push({
          ...base,
          kind: "desktop",
          op: secret ? { op: "type", text: REDACTED, secret: true } : { op: "type", text: e.text },
          redacted: secret,
        });
        break;
      }
      case "key":
        out.push({
          ...base,
          kind: "desktop",
          op: { op: "key", combo: comboOf(e.key, e.mods) },
          redacted: false,
        });
        break;
      default:
        break;
    }
  }
  return out;
}

export const isoOf = (v: number | string | null | undefined): string | null =>
  v === null || v === undefined ? null : new Date(v).toISOString();

export interface ImportResult {
  name: string;
  dir: string;
  actions: number;
  events: number;
  frames: number;
  trees: number;
}

export interface SessionData {
  prefix: string;
  events: Event[];
  /** The segments' text, concatenated: the events as the device wrote them. */
  raw: string;
  meta: SessionMeta | null;
  /** Frame number → bucket key. */
  frameKeys: Map<number, string>;
  /** Tree number → bucket key and its kind: `json` (a window's tree) or `txt` (a page outline). */
  treeKeys: Map<number, { key: string; ext: "json" | "txt" }>;
}

/** A session's events (every segment, in order), its meta and where its frames are. */
export async function readSession(
  store: TrackStore,
  ref: { device: string; session: string },
): Promise<SessionData> {
  const device = checkDevice(ref.device);
  if (!SESSION.test(ref.session)) throw new Error(`not a session id: ${ref.session}`);
  const prefix = `${device}/${ref.session}/`;
  const objects = (await store.list(prefix)).flatMap((obj) => {
    const k = parseKey(obj.key);
    return k ? [{ ...obj, k }] : [];
  });
  const segments = objects
    .flatMap((x) => (x.k.kind === "events" ? [{ key: x.key, segment: x.k.segment }] : []))
    .sort((a, b) => Number(a.segment) - Number(b.segment));
  if (!segments.length) throw new Error(`no segments under ${prefix}`);

  const events: Event[] = [];
  let raw = "";
  for (const s of segments) {
    const text = gunzipSync(await store.get(s.key)).toString("utf8");
    raw += text.endsWith("\n") ? text : `${text}\n`;
    events.push(...parseEvents(text));
  }

  const metaKey = objects.find((x) => x.k.kind === "meta")?.key;
  const meta = metaKey
    ? (JSON.parse((await store.get(metaKey)).toString("utf8")) as SessionMeta)
    : null;

  const frameKeys = new Map<number, string>();
  const treeKeys = new Map<number, { key: string; ext: "json" | "txt" }>();
  for (const x of objects) {
    if (x.k.kind === "frame") frameKeys.set(x.k.frame, x.key);
    if (x.k.kind === "tree") treeKeys.set(x.k.tree, { key: x.key, ext: x.k.ext });
  }
  return { prefix, events, raw, meta, frameKeys, treeKeys };
}

/** The labels for a session, if `autotrack label` has run: the bucket's, else the local copy. */
export async function readLabels(
  store: TrackStore,
  ref: { device: string; session: string },
  localFile: string,
): Promise<Labels | null> {
  const key = labelKey(ref.device, ref.session);
  try {
    if ((await store.list(key)).some((o) => o.key === key))
      return JSON.parse((await store.get(key)).toString("utf8")) as Labels;
  } catch {}
  try {
    return JSON.parse(await readFile(localFile, "utf8")) as Labels;
  } catch {
    return null;
  }
}

export async function importSession(
  store: TrackStore,
  ref: { device: string; session: string },
  o: { root: string; name?: string; site?: string },
): Promise<ImportResult> {
  const device = checkDevice(ref.device);
  const { events, raw, meta, frameKeys, treeKeys } = await readSession(store, ref);

  const name = o.name ?? `${device}-${ref.session.toLowerCase()}`;
  const dir = recordingDir(o.root, name);
  const trackDir = join(dir, "track");
  await mkdir(join(trackDir, "frames"), { recursive: true });
  if (treeKeys.size) await mkdir(join(trackDir, "trees"), { recursive: true });

  // Only the frames the recording points at come down; the bucket keeps the rest.
  const saved = new Set<number>();
  const screenshotOf = (frame: number | undefined) => {
    if (frame === undefined || !frameKeys.has(frame)) return undefined;
    saved.add(frame);
    return `${name}/track/frames/${frame}.jpg`;
  };
  const labels = await readLabels(store, ref, join(trackDir, "labels.json"));
  const intents = new Map<number, string>();
  for (const a of labels?.acts ?? []) if (a.intent) intents.set(a.t, a.intent);
  const actions = eventsToActions(events, screenshotOf, intents);
  for (const n of saved) {
    await writeFile(
      join(trackDir, "frames", `${n}.jpg`),
      await store.get(frameKeys.get(n) as string),
    );
  }
  for (const [n, { key, ext }] of treeKeys)
    await writeFile(join(trackDir, "trees", `${n}.${ext}`), gunzipSync(await store.get(key)));
  await writeFile(join(trackDir, "events.jsonl"), raw);
  if (labels)
    await writeFile(join(trackDir, "labels.json"), `${JSON.stringify(labels, null, 2)}\n`);
  if (meta) await writeFile(join(trackDir, "session.json"), `${JSON.stringify(meta, null, 2)}\n`);

  const last = events[events.length - 1];
  const first = events[0];
  const startedAt =
    isoOf(meta?.startedAt) ?? (first ? new Date(first.ts).toISOString() : new Date().toISOString());
  const finishedAt = isoOf(meta?.endedAt) ?? (last ? new Date(last.ts).toISOString() : startedAt);
  const rec: Recording = {
    name,
    site: o.site ?? "desktop",
    startedAt,
    finishedAt,
    actions,
    trace: null,
    terminal: null,
    commands: [],
  };
  await saveRecording(o.root, rec);
  return {
    name,
    dir,
    actions: actions.length,
    events: events.length,
    frames: saved.size,
    trees: treeKeys.size,
  };
}
