/**
 * Episodes (design doc "Derived offline", step 3): runs of acts toward one goal. A `task` marker
 * (the person's own "what are you doing") splits the session and names the goal. Where there is no
 * marker, an idle gap of 2 minutes or more splits it, and so does a switch to an unrelated app or
 * domain that is held for 30 seconds or more.
 */
import { getDomain } from "tldts";
import type { Act } from "./join.js";
import type { Event } from "./types.js";

export const IDLE_MS = 2 * 60_000;
export const HELD_MS = 30_000;

export interface Episode {
  id: string;
  /** Index range into the acts: `from` inclusive, `to` exclusive. */
  from: number;
  to: number;
  /** ms since session start. */
  start: number;
  end: number;
  /** The person's goal from a `task` marker; absent for an unmarked stretch. */
  goal?: string;
}

/** Registrable domain of a url, or the host (an IP, localhost). */
export function domainOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname;
    return getDomain(host) ?? host ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * What an act is "in": the page's domain when it is in a browser that reported one, else the app.
 * An OS click in Chrome has no url of its own; it takes the domain Chrome last reported.
 */
export function contexts(acts: readonly Act[]): string[] {
  const domainOfApp = new Map<string, string>();
  let lastApp = "";
  return acts.map((a) => {
    const app = a.app?.id ?? lastApp;
    lastApp = app;
    const d = a.url ? domainOf(a.url) : undefined;
    if (d && app) domainOfApp.set(app, d);
    return d ?? domainOfApp.get(app) ?? app;
  });
}

/** Start indexes of the episodes in `acts[from, to)` when no one marked them. */
export function splitUnmarked(
  acts: readonly Act[],
  from: number,
  to: number,
  o: { idleMs?: number; heldMs?: number } = {},
): number[] {
  const idleMs = o.idleMs ?? IDLE_MS;
  const heldMs = o.heldMs ?? HELD_MS;
  const keys = contexts(acts);
  const starts: number[] = [];
  let cur = keys[from];
  for (let i = from + 1; i < to; i++) {
    const a = acts[i] as Act;
    if (a.ts - (acts[i - 1] as Act).end >= idleMs) {
      starts.push(i);
      cur = keys[i];
      continue;
    }
    if (keys[i] === cur || !keys[i]) continue;
    // Away from `cur`: until the first act back in it, or the end of this stretch.
    let back = i + 1;
    while (back < to && keys[back] !== cur) back++;
    const until = back < to ? (acts[back] as Act).ts : (acts[to - 1] as Act).end;
    if (until - a.ts >= heldMs) {
      starts.push(i);
      cur = keys[i];
    }
  }
  return starts;
}

type TaskEvent = Extract<Event, { kind: "task" }>;

/** Episodes of a session. Empty stretches (a marker with no acts after it) make none. */
export function splitEpisodes(
  acts: readonly Act[],
  events: readonly Event[],
  o: { idleMs?: number; heldMs?: number } = {},
): Episode[] {
  const tasks = events
    .filter((e): e is TaskEvent & Event => e.kind === "task")
    .sort((a, b) => a.ts - b.ts);
  // Stretches: [from, to, goal?], cut at each marker.
  const stretches: { from: number; to: number; goal?: string; marked: boolean }[] = [];
  let at = 0;
  let goal: string | undefined;
  const indexAfter = (ts: number) => {
    let i = at;
    while (i < acts.length && (acts[i] as Act).ts < ts) i++;
    return i;
  };
  for (const m of tasks) {
    const i = indexAfter(m.ts);
    if (i > at) stretches.push({ from: at, to: i, ...(goal ? { goal } : {}), marked: !!goal });
    at = i;
    goal = m.goal.trim() && !m.done ? m.goal.trim() : undefined;
  }
  if (acts.length > at)
    stretches.push({ from: at, to: acts.length, ...(goal ? { goal } : {}), marked: !!goal });

  const out: Episode[] = [];
  for (const s of stretches) {
    const cuts = s.marked ? [] : splitUnmarked(acts, s.from, s.to, o);
    const bounds = [s.from, ...cuts, s.to];
    for (let k = 0; k + 1 < bounds.length; k++) {
      const from = bounds[k] as number;
      const to = bounds[k + 1] as number;
      out.push({
        id: `e${out.length + 1}`,
        from,
        to,
        start: (acts[from] as Act).t,
        end: (acts[to - 1] as Act).t,
        ...(s.goal ? { goal: s.goal } : {}),
      });
    }
  }
  return out;
}
