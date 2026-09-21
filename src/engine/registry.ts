/**
 * `Runs/all`: the list of every run the UI can show. Run objects send it
 * each event; it keeps one row per run with the latest status. A
 * projection, not a source of truth: a run's own state is the truth.
 */
import * as restate from "@restatedev/restate-sdk";
import type { RunEvent } from "./events.js";
import { runId } from "./events.js";
import { applyRunEvent, type ListQuery, pageOf, type RunRow, trimRows } from "./rows.js";

export const REGISTRY = { name: "Runs" } as const;
export const REGISTRY_KEY = "all";

const ROWS = "rows";

export type { ListQuery, RunRow } from "./rows.js";
export {
  applyRunEvent,
  compareRows,
  cursorOf,
  KEEP_ROWS,
  LIST_LIMIT,
  pageOf,
  placeRow,
  trimRows,
} from "./rows.js";

export const runsRegistry = restate.object({
  name: REGISTRY.name,
  handlers: {
    record: async (ctx: restate.ObjectContext, event: RunEvent): Promise<void> => {
      const rows = (await ctx.get<Record<string, RunRow>>(ROWS)) ?? {};
      const id = runId(event.run);
      rows[id] = applyRunEvent(rows[id] ?? null, event);
      ctx.set(ROWS, trimRows(rows));
    },
    list: restate.handlers.object.shared(
      async (ctx: restate.ObjectSharedContext, q: ListQuery): Promise<RunRow[]> =>
        pageOf(Object.values((await ctx.get<Record<string, RunRow>>(ROWS)) ?? {}), q),
    ),
    forget: async (ctx: restate.ObjectContext, id: string): Promise<void> => {
      const rows = (await ctx.get<Record<string, RunRow>>(ROWS)) ?? {};
      delete rows[id];
      ctx.set(ROWS, rows);
    },
  },
});

export type RunsRegistry = typeof runsRegistry;
