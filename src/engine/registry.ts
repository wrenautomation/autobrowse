/**
 * `Runs/all`: the list of every run the UI can show. Run objects send it
 * each event; it keeps one row per run with the latest status. A
 * projection, not a source of truth: a run's own state is the truth.
 */
import * as restate from "@restatedev/restate-sdk";
import type { RunEvent } from "./events.js";
import { runId } from "./events.js";
import type { RunStatus } from "./run.js";

export const REGISTRY = { name: "Runs" } as const;
export const REGISTRY_KEY = "all";

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

const ROWS = "rows";

export const runsRegistry = restate.object({
  name: REGISTRY.name,
  handlers: {
    record: async (ctx: restate.ObjectContext, event: RunEvent): Promise<void> => {
      const rows = (await ctx.get<Record<string, RunRow>>(ROWS)) ?? {};
      const id = runId(event.run);
      const row: RunRow = rows[id] ?? {
        workflow: event.run.workflow,
        key: event.run.key,
        startedAt: event.at,
        updatedAt: event.at,
        status: "running",
        gate: null,
        lastStep: null,
      };
      row.updatedAt = event.at;
      switch (event.type) {
        case "started":
          Object.assign(row, {
            startedAt: event.at,
            status: "running",
            gate: null,
            lastStep: null,
          });
          break;
        case "step":
          row.lastStep = event.step;
          row.status = "running";
          break;
        case "gate-opened":
          row.status = "waiting";
          row.gate = event.gate.name;
          break;
        case "gate-answered":
          row.gate = null;
          row.status = event.approved ? "running" : "rejected";
          break;
        case "paused":
        case "resumed":
          break;
        case "finished":
          row.status = event.status;
          row.gate = null;
          break;
        case "reset":
          row.status = "reset";
          row.gate = null;
          break;
      }
      rows[id] = row;
      ctx.set(ROWS, rows);
    },
    list: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext): Promise<RunRow[]> =>
        Object.values((await ctx.get<Record<string, RunRow>>(ROWS)) ?? {}).sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        ),
    ),
    forget: async (ctx: restate.ObjectContext, id: string): Promise<void> => {
      const rows = (await ctx.get<Record<string, RunRow>>(ROWS)) ?? {};
      delete rows[id];
      ctx.set(ROWS, rows);
    },
  },
});

export type RunsRegistry = typeof runsRegistry;
