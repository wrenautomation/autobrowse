/**
 * `Runs/all`: the list of every run the UI can show. Run objects send it
 * each event; it keeps one row per run with the latest status. A
 * projection, not a source of truth: a run's own state is the truth.
 */
import * as restate from "@restatedev/restate-sdk";
import { DEFAULT_OWNER, named } from "../owner.js";
import type { RunEvent } from "./events.js";
import { runId } from "./events.js";
import {
  applyRunEvent,
  type ListQuery,
  orderedRows,
  pageOfOrdered,
  placeRow,
  type RunRow,
  trimRows,
} from "./rows.js";

export const REGISTRY = { name: "Runs" } as const;
export const REGISTRY_KEY = "all";

const ROWS = "rows";
/** A list newest first; a map from before 2026-09-22 reads once more and is written back as a list. */
type Stored = RunRow[] | Record<string, RunRow>;

export type { ListQuery, RunRow } from "./rows.js";
export {
  applyRunEvent,
  compareRows,
  cursorOf,
  KEEP_ROWS,
  LIST_LIMIT,
  orderedRows,
  pageOf,
  pageOfOrdered,
  placeRow,
  trimRows,
} from "./rows.js";

/** The owner's registry: `Runs` for the default owner, `Runs_<owner>` for any other. */
export const registryOf = (owner: string = DEFAULT_OWNER) => ({
  name: named(REGISTRY.name, owner),
});

export const runsRegistryFor = (owner: string = DEFAULT_OWNER) =>
  restate.object({
    name: registryOf(owner).name,
    handlers: {
      record: async (ctx: restate.ObjectContext, event: RunEvent): Promise<void> => {
        // Kept newest first: an event places its row (one pass), a page is a slice.
        const rows = orderedRows(await ctx.get<Stored>(ROWS));
        const id = runId(event.run);
        const have = rows.find((r) => runId(r) === id) ?? null;
        ctx.set(ROWS, trimRows(placeRow(rows, applyRunEvent(have, event))));
      },
      list: restate.handlers.object.shared(
        async (ctx: restate.ObjectSharedContext, q: ListQuery): Promise<RunRow[]> =>
          pageOfOrdered(orderedRows(await ctx.get<Stored>(ROWS)), q),
      ),
      forget: async (ctx: restate.ObjectContext, id: string): Promise<void> => {
        const rows = orderedRows(await ctx.get<Stored>(ROWS));
        ctx.set(
          ROWS,
          rows.filter((r) => runId(r) !== id),
        );
      },
    },
  });

export const runsRegistry = runsRegistryFor();
export type RunsRegistry = ReturnType<typeof runsRegistryFor>;
