/**
 * Run rows: the registry's projection of a run, one per run, and the fold
 * that keeps it current. No runtime deps: the UI folds live events with the
 * same function instead of fetching the list again on every event.
 */
import type { RunEvent } from "./events.js";
import type { RunStatus } from "./run.js";

export interface RunRow {
  workflow: string;
  key: string;
  startedAt: string;
  updatedAt: string;
  status: RunStatus | "reset";
  /** The open gate's name, when waiting. */
  gate: string | null;
  lastStep: string | null;
}

/** The next row after an event; `null` for a run the registry has not seen. Pure: the page folds live events the same way. */
export function applyRunEvent(row: RunRow | null, event: RunEvent): RunRow {
  const next: RunRow = row
    ? { ...row }
    : {
        workflow: event.run.workflow,
        key: event.run.key,
        startedAt: event.at,
        updatedAt: event.at,
        status: "running",
        gate: null,
        lastStep: null,
      };
  next.updatedAt = event.at;
  switch (event.type) {
    case "started":
      Object.assign(next, { startedAt: event.at, status: "running", gate: null, lastStep: null });
      break;
    case "step":
      next.lastStep = event.step;
      next.status = "running";
      break;
    case "gate-opened":
      next.status = "waiting";
      next.gate = event.gate.name;
      break;
    case "gate-answered":
      next.gate = null;
      next.status = event.approved ? "running" : "rejected";
      break;
    case "paused":
    case "resumed":
      break;
    case "finished":
      next.status = event.status;
      next.gate = null;
      break;
    case "reset":
      next.status = "reset";
      next.gate = null;
      break;
  }
  return next;
}

/** A page of the list: newest first, `limit` rows (100 unless asked), those before `before`. */
export interface ListQuery {
  limit?: number;
  /** The previous page's last row as `cursorOf` gives it: the next page starts after it. A bare `updatedAt` still works. */
  before?: string;
}

export const LIST_LIMIT = 100;

const idOf = (r: Pick<RunRow, "workflow" | "key">) => `${r.workflow}/${r.key}`;

/** Where a page ends: the row's place in the order, for the next page's `before`. */
export function cursorOf(r: Pick<RunRow, "updatedAt" | "workflow" | "key">): string {
  return `${r.updatedAt}~${idOf(r)}`;
}

/** Newest first; two rows updated in the same instant order by id, so a page edge cannot hide one. */
export function compareRows(a: RunRow, b: RunRow): number {
  return b.updatedAt.localeCompare(a.updatedAt) || idOf(b).localeCompare(idOf(a));
}

function isBefore(r: RunRow, cursor: string): boolean {
  const i = cursor.indexOf("~");
  if (i < 0) return r.updatedAt < cursor;
  const at = cursor.slice(0, i);
  return r.updatedAt < at || (r.updatedAt === at && idOf(r) < cursor.slice(i + 1));
}

export function pageOf(rows: RunRow[], q: ListQuery = {}): RunRow[] {
  const limit = Math.max(1, Math.min(q.limit ?? LIST_LIMIT, 1_000));
  return rows
    .filter((r) => !q.before || isBefore(r, q.before))
    .sort(compareRows)
    .slice(0, limit);
}
