/** Small hand-made autotrack event lists for the join, signal, episode and label tests. */
import { gzipSync } from "node:zlib";
import type { Act } from "../src/autotrack/join.js";
import { buildActs } from "../src/autotrack/join.js";
import type { TrackWriter } from "../src/autotrack/store.js";
import type { Element, Event, WebTarget } from "../src/autotrack/types.js";

export const T0 = 1_760_000_000_000;
export const APP = { name: "Finder", id: "com.apple.finder", pid: 1 };
export const CHROME = { name: "Chrome", id: "com.google.Chrome", pid: 2 };

type Body = Event extends infer E ? (E extends unknown ? Omit<E, "t" | "ts"> : never) : never;

/** An event `ms` after the session start. */
export function at(ms: number, body: Body & { app?: Event["app"] }): Event {
  return { t: ms, ts: T0 + ms, ...body } as Event;
}

export const el = (name: string, o: Partial<Element> = {}): Element => ({
  role: "AXButton",
  name,
  x: 90,
  y: 90,
  width: 40,
  height: 20,
  secure: false,
  ...o,
});

export const click = (
  ms: number,
  x = 100,
  y = 100,
  o: Partial<Extract<Event, { kind: "click" }>> = {},
) => at(ms, { kind: "click", x, y, button: "left", count: 1, app: APP, ...o });

export const text = (ms: number, value: string, o: { redacted?: boolean } = {}) =>
  at(ms, { kind: "text", text: value, redacted: o.redacted ?? false, app: APP });

export const key = (ms: number, k: string, mods: ("ctrl" | "alt" | "shift" | "meta")[] = []) =>
  at(ms, { kind: "key", key: k, mods, app: APP });

export const web = (
  ms: number,
  act: string,
  o: {
    x?: number;
    y?: number;
    url?: string;
    target?: WebTarget;
    [k: string]: unknown;
  } = {},
) =>
  at(ms, {
    kind: "web",
    act,
    tab: 1,
    frame: 0,
    url: "https://app.example.com/a",
    title: "A",
    ...o,
  } as Body);

export const acts = (events: Event[]): Act[] => buildActs(events);

/** An in-memory bucket with a gzip helper; `put` records writes. */
export function memoryStore(objects: Map<string, Buffer> = new Map()): TrackWriter & {
  objects: Map<string, Buffer>;
  puts: string[];
  gets: string[];
} {
  const puts: string[] = [];
  const gets: string[] = [];
  return {
    objects,
    puts,
    gets,
    async list(prefix) {
      return [...objects]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, b]) => ({ key, size: b.length }));
    },
    async get(k) {
      gets.push(k);
      const b = objects.get(k);
      if (!b) throw new Error(`NoSuchKey ${k}`);
      return b;
    },
    async put(k, body) {
      puts.push(k);
      objects.set(k, body);
    },
  };
}

export const gz = (events: Event[]) =>
  gzipSync(Buffer.from(`${events.map((e) => JSON.stringify(e)).join("\n")}\n`));
