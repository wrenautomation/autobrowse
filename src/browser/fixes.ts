/**
 * Fixes: the locators a flow's source got wrong, and what worked instead.
 * A repair that works is kept here by flow, goal and the hints that broke.
 * The next run tries the fix first, so a moved button costs no 15s wait and
 * no model call. A fix that stops working is dropped, and the repairer runs
 * again. `autobrowse repairs` lists them: each row is a line to change in the
 * flow's source, after which `--forget` clears it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Hints } from "./locate.js";
import type { RepairReport } from "./repair.js";

export interface Fix {
  /** `site/name`, the base site: `x@wren` and `x` share a fix. */
  flow: string;
  goal: string;
  /** What the source says. */
  failed: Hints;
  /** What worked. */
  hints: Hints;
  reason: string;
  url: string;
  found: string;
  /** Runs that went through on the fix since. */
  used: number;
  lastUsed?: string;
}

export interface Fixes {
  /** The fix for these hints on this step, if one is kept. */
  find(flow: string, goal: string, failed: Hints): Hints | null;
  /** A repair that worked: kept. One that did not: ignored. */
  learn(report: RepairReport): void;
  /** The fix went through again. */
  used(flow: string, goal: string, failed: Hints): void;
  /** The fix no longer works: dropped, so the repairer looks again. */
  drop(flow: string, goal: string, failed: Hints): void;
  list(): Fix[];
  /** Drop every fix for a flow (its source was changed), or one goal of it. Returns how many. */
  forget(flow: string, goal?: string): number;
}

/** `x@wren/login` → `x/login`. */
export const flowKey = (site: string, name: string) => `${site.split("@")[0]}/${name}`;

const key = (flow: string, goal: string, failed: Hints) =>
  `${flow}\n${goal}\n${JSON.stringify(failed)}`;

/** At most this many kept; the oldest go first. A fix belongs in the source, not here for good. */
const LIMIT = 500;

function table(load: () => Fix[], save: (fixes: Fix[]) => void, now: () => Date): Fixes {
  let rows: Map<string, Fix> | null = null;
  const all = () => {
    rows ??= new Map(load().map((f) => [key(f.flow, f.goal, f.failed), f]));
    return rows;
  };
  const write = () => save([...all().values()].slice(-LIMIT));
  return {
    find: (flow, goal, failed) => all().get(key(flow, goal, failed))?.hints ?? null,
    learn(r) {
      if (!r.ok) return;
      const at = r.flow.indexOf("/");
      const flow = flowKey(r.flow.slice(0, at), r.flow.slice(at + 1));
      const k = key(flow, r.goal, r.failed);
      all().delete(k);
      all().set(k, {
        flow,
        goal: r.goal,
        failed: r.failed,
        hints: r.hints,
        reason: r.reason,
        url: r.url,
        found: now().toISOString(),
        used: 0,
      });
      write();
    },
    used(flow, goal, failed) {
      const f = all().get(key(flow, goal, failed));
      if (!f) return;
      f.used += 1;
      f.lastUsed = now().toISOString();
      write();
    },
    drop(flow, goal, failed) {
      if (all().delete(key(flow, goal, failed))) write();
    },
    list: () => [...all().values()],
    forget(flow, goal) {
      let n = 0;
      for (const [k, f] of all())
        if (f.flow === flow && (goal === undefined || f.goal === goal)) {
          all().delete(k);
          n += 1;
        }
      if (n) write();
      return n;
    },
  };
}

export function fileFixes(path: string, now: () => Date = () => new Date()): Fixes {
  return table(
    () => {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as Fix[];
      } catch {
        return [];
      }
    },
    (fixes) => {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(fixes, null, 1)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    },
    now,
  );
}

export function memoryFixes(now: () => Date = () => new Date()): Fixes {
  let kept: Fix[] = [];
  return table(
    () => kept,
    (f) => {
      kept = f;
    },
    now,
  );
}
