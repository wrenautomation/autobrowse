/**
 * What a caller may do to this resource *right now*, in the response that
 * describes it. A run's legal actions depend on its gate and whether it is
 * paused; a setup step's depend on what an earlier step made. An agent that
 * reads them needs no vocabulary of ours, and cannot try an action the
 * worker will only refuse.
 *
 * This is the one place hypermedia earns its weight here: state decides
 * legality. Everything else stays a plain level-2 resource — the site
 * facade in particular keeps each vendor's own shape, untouched.
 */
import type { RunStatusView } from "../engine/object.js";
import type { SiteRow } from "../sites/index.js";
import type { Method } from "../sites/types.js";

export interface Affordance {
  /** What it does, in a verb: `approve`, `pause`, `run`, `done`. */
  rel: string;
  method: Method;
  /** Ready to call: ids already in it, never a template. */
  path: string;
  /** Field → what it is; absent when the call takes no body. */
  body?: Record<string, string>;
  /** Only when the caller would otherwise wonder. */
  note?: string;
}

const afford = (
  rel: string,
  method: Method,
  path: string,
  extra: { body?: Record<string, string>; note?: string } = {},
): Affordance => ({ rel, method, path, ...extra });

/** A run: gate first (it is what blocks), then pause/play, then start again. */
export function runAffordances(s: RunStatusView): Affordance[] {
  const at = `/api/runs/${encodeURIComponent(s.workflow)}/${encodeURIComponent(s.key)}`;
  const out: Affordance[] = [];
  if (s.gate)
    out.push(
      afford("approve", "POST", `${at}/approve`, {
        body: { note: "optional, kept on the decision" },
        note: `answers the ${s.gate.name} gate on step ${s.gate.step}`,
      }),
      afford("reject", "POST", `${at}/reject`, { body: { note: "optional, why" } }),
    );
  out.push(
    s.paused ? afford("play", "POST", `${at}/play`) : afford("pause", "POST", `${at}/pause`),
  );
  const finished = s.outcome !== null && s.outcome.status !== "running";
  if (finished || (!s.gate && s.outcome === null))
    out.push(
      afford("run", "POST", at, {
        body: { plan: "the workflow's plan" },
        ...(finished ? { note: `last run ${s.outcome?.status}` } : {}),
      }),
    );
  if (s.outcome !== null) out.push(afford("reset", "POST", `${at}/reset`));
  return out;
}

/** A site's setup: only the steps whose inputs exist, and only while they have something to make. */
export function setupAffordances(row: SiteRow): Affordance[] {
  const at = `/api/sites/${encodeURIComponent(row.site)}/setup`;
  return row.setup
    .filter((s) => !s.done && s.blockedOn.length === 0 && !s.unrecorded)
    .map((s) =>
      afford("setup", "POST", `${at}/${encodeURIComponent(s.name)}`, {
        note: `makes ${s.makes.join(", ")}`,
      }),
    );
}

/** `autobrowse site setup <site> <step> [--account <a>]` → the same step over HTTP. */
export function setupPath(how: string): string | null {
  const m = /^autobrowse site setup (\S+) (\S+)(?: --account (\S+))?$/.exec(how);
  if (!m) return null;
  const path = `/api/sites/${encodeURIComponent(m[1] as string)}/setup/${encodeURIComponent(m[2] as string)}`;
  return m[3] ? `${path}?account=${encodeURIComponent(m[3])}` : path;
}

/** A need: the step that clears it when it is one autobrowse can run, and the mark either way. */
export function needAffordances(row: {
  id: string;
  done: boolean;
  by: "check" | "you" | null;
  how: readonly string[];
  checked: boolean;
}): Affordance[] {
  const at = `/api/needs/${encodeURIComponent(row.id)}/done`;
  if (row.done)
    return row.by === "you"
      ? [afford("undo", "DELETE", at, { note: "the mark was yours, not a check" })]
      : [];
  const out: Affordance[] = [];
  for (const how of row.how) {
    const path = setupPath(how);
    if (path) out.push(afford("setup", "POST", path, { note: how }));
  }
  out.push(
    afford("done", "POST", at, {
      body: { note: "optional, what you did" },
      ...(row.checked
        ? { note: "a check clears this row on its own; say so only if it cannot" }
        : {}),
    }),
  );
  return out;
}
