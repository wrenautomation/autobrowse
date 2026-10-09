/**
 * Success rates: how often autobrowse reaches what it was asked for, and
 * every try that did not, read back from the ledgers that keep them for good.
 * A failure is any try that did not lead to the end state: a command that
 * erred and was tried again, a call Restate retried, a run with no
 * `achieved`. Nothing here aborts anything; it only counts.
 *
 * - Explore runs (`runs/`): each run's verdict, and each command that erred.
 *   A locator that timed out on a target the page just showed is a target
 *   miss: the page digest pointed at something that was not there or not
 *   usable. Its rate per act is the digest's health.
 * - Site calls (`calls/`): every try of a `sites`/`desk` call; per call, how
 *   many tries it took and how it ended.
 * - Agent steps (`steps.jsonl`) and model calls (`llm/`): steps and calls that failed.
 */
import type { LlmCall } from "../llm/ledger.js";
import type { SiteCallRow } from "./calls.js";
import { settledCalls } from "./calls.js";
import type { RunSummary } from "./log.js";
import type { Cmd } from "./tokens.js";

/** Commands that act on a target the page showed: their misses are the digest's. */
const ACTS = new Set(["click", "fill", "select", "press", "upload", "check", "hover"]);

/** Why an explore command failed, by its error's text. */
export type CmdFailure =
  | "target-miss"
  | "wait-timeout"
  | "sign-in"
  | "gate"
  | "cap"
  | "unknown-site"
  | "other";

export function cmdFailure(error: string | null): CmdFailure {
  const e = error ?? "";
  if (/^locator\.\w+: Timeout/.test(e)) return "target-miss";
  if (/Timeout \d+ms exceeded/.test(e)) return "wait-timeout";
  if (/payment step|gate/i.test(e)) return "gate";
  if (/\bcap\b.*\bused\b|\b429\b/i.test(e)) return "cap";
  if (/unknown-site/.test(e)) return "unknown-site";
  if (/password|login|sign-?in|verification|signed out|secrets|code is not available/i.test(e))
    return "sign-in";
  return "other";
}

/** Why a site call failed, by status: whose problem it is. */
export type CallFailure = "request" | "cap" | "blocked" | "no-leg" | "platform" | "unexpected";

export function callFailure(row: Pick<SiteCallRow, "status" | "terminal">): CallFailure {
  const s = row.status;
  if (!row.terminal || s === null) return "unexpected";
  if (s === 400 || s === 404 || s === 422) return "request";
  if (s === 429) return "cap";
  if (s === 409) return "blocked";
  if (s === 501) return "no-leg";
  return "platform";
}

/** A done/failed verdict, or none (closed, idle). `saved` counts as reached: the run compiled. */
const REACHED = new Set(["achieved", "saved"]);
const FAILED = new Set(["failed"]);

/** Explore commands that erred in one run at or past this count: the run struggled. */
export const STRUGGLE = 3;

export interface StepLike {
  at: string;
  site: string;
  ok: boolean;
  error: string | null;
}

export interface Rate {
  n: number;
  failed: number;
  /** failed / n, 0 when n is 0. */
  rate: number;
}

const rate = (n: number, failed: number): Rate => ({
  n,
  failed,
  rate: n ? failed / n : 0,
});

export interface SuccessReport {
  since: string;
  until: string;
  explore: {
    runs: number;
    reached: number;
    failed: number;
    /** No verdict: the session closed or idled without `done`. */
    unknown: number;
    /** reached / (reached + failed): only runs that said how they ended. */
    successRate: number | null;
    commands: Rate;
    /** Target misses over act commands: how often the digest pointed wrong. */
    targetMiss: Rate;
    byFailure: { kind: CmdFailure; n: number; example: string }[];
    byCmd: ({ cmd: string } & Rate)[];
    bySite: ({ site: string; runs: number; reached: number; unknown: number } & Rate)[];
    /** Runs with STRUGGLE or more failed commands. */
    struggled: {
      run: string;
      site: string;
      goal: string | null;
      outcome: string;
      failed: number;
    }[];
  };
  calls: {
    /** Calls, one per invocation; `failed` = ended in an error. */
    settled: Rate;
    tries: number;
    /** Calls that took more than one try. */
    retried: number;
    byFailure: { kind: CallFailure; n: number; example: string }[];
    byRoute: ({ site: string; route: string; retried: number; topError: string | null } & Rate)[];
    /** Rows imported from Restate or the caps ledger, not written live. */
    imported: number;
  };
  steps: Rate;
  models: Rate;
  days: { day: string; runs: number; reached: number; commands: Rate; calls: Rate }[];
}

const dayOf = (iso: string) => iso.slice(0, 10);

function tally<K extends string>(
  xs: readonly { kind: K; error: string }[],
): { kind: K; n: number; example: string }[] {
  const m = new Map<K, { kind: K; n: number; example: string }>();
  for (const x of xs) {
    const had = m.get(x.kind);
    if (had) had.n++;
    else m.set(x.kind, { kind: x.kind, n: 1, example: x.error.slice(0, 120) });
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}

/** Routes with ids in them read as one: `/r/abc/new` and `/r/xyz/new` are one route. */
export function routeShape(route: string): string {
  return route
    .split("?")[0]
    ?.replace(/\/(?=[A-Za-z0-9_-]{5,}(?:\/|$))[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*(?=\/|$)/g, "/{id}")
    .replace(/\/r\/[^/]+/, "/r/{sub}")
    .replace(/\/user\/[^/]+/, "/user/{name}") as string;
}

export function successReport(o: {
  since: string;
  until: string;
  runs: readonly RunSummary[];
  cmds: readonly Cmd[];
  calls: readonly SiteCallRow[];
  steps: readonly StepLike[];
  models: readonly LlmCall[];
  site?: string;
}): SuccessReport {
  const inWindow = (at: string) => at >= o.since && at <= o.until;
  const siteOk = (s: string) => !o.site || s === o.site || s.startsWith(`${o.site}@`);
  const runs = o.runs.filter((r) => inWindow(r.startedAt) && siteOk(r.site));
  const cmds = o.cmds.filter((c) => inWindow(c.at) && siteOk(c.site));
  const rows = o.calls.filter((c) => inWindow(c.at) && siteOk(c.site));
  const calls = settledCalls(rows);

  const reached = runs.filter((r) => REACHED.has(r.outcome)).length;
  const failedRuns = runs.filter((r) => FAILED.has(r.outcome)).length;
  const failedCmds = cmds.filter((c) => !c.ok);
  const acts = cmds.filter((c) => ACTS.has(c.cmd));
  const misses = acts.filter((c) => !c.ok && cmdFailure(c.error) === "target-miss");

  // A command belongs to the run whose life covers it: the newest run of its site started at or before it.
  const runsBySite = new Map<string, RunSummary[]>();
  for (const r of [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt)))
    runsBySite.set(r.site, [...(runsBySite.get(r.site) ?? []), r]);
  const failsByRun = new Map<string, number>();
  for (const c of failedCmds) {
    const own = (runsBySite.get(c.site) ?? []).filter(
      (r) => r.startedAt <= c.at && c.at <= r.endedAt,
    );
    const r = own.at(-1);
    if (r) failsByRun.set(r.run, (failsByRun.get(r.run) ?? 0) + 1);
  }

  const sites = [...new Set([...runs.map((r) => r.site), ...cmds.map((c) => c.site)])];
  const bySite = sites
    .map((site) => {
      const rs = runs.filter((r) => r.site === site);
      const cs = cmds.filter((c) => c.site === site);
      return {
        site,
        runs: rs.length,
        reached: rs.filter((r) => REACHED.has(r.outcome)).length,
        unknown: rs.filter((r) => !REACHED.has(r.outcome) && !FAILED.has(r.outcome)).length,
        ...rate(cs.length, cs.filter((c) => !c.ok).length),
      };
    })
    .sort((a, b) => b.failed - a.failed || b.n - a.n);

  const cmdNames = [...new Set(cmds.map((c) => c.cmd))];
  const byCmd = cmdNames
    .map((cmd) => {
      const cs = cmds.filter((c) => c.cmd === cmd);
      return { cmd, ...rate(cs.length, cs.filter((c) => !c.ok).length) };
    })
    .filter((r) => r.failed > 0)
    .sort((a, b) => b.failed - a.failed);

  const routes = new Map<string, (typeof calls)[number][]>();
  for (const c of calls) {
    const k = `${c.site} ${routeShape(c.route)}`;
    routes.set(k, [...(routes.get(k) ?? []), c]);
  }
  const byRoute = [...routes.values()]
    .map((cs) => {
      const failed = cs.filter((c) => !c.ok);
      const first = cs[0] as (typeof cs)[number];
      return {
        site: first.site,
        route: routeShape(first.route),
        ...rate(cs.length, failed.length),
        retried: cs.filter((c) => c.attempts > 1).length,
        topError: failed[0]?.error ?? null,
      };
    })
    .filter((r) => r.failed > 0 || r.retried > 0)
    .sort((a, b) => b.failed - a.failed || b.retried - a.retried);

  const days = [
    ...new Set([
      ...runs.map((r) => dayOf(r.startedAt)),
      ...cmds.map((c) => dayOf(c.at)),
      ...calls.map((c) => dayOf(c.at)),
    ]),
  ]
    .sort()
    .map((day) => {
      const rs = runs.filter((r) => dayOf(r.startedAt) === day);
      const cs = cmds.filter((c) => dayOf(c.at) === day);
      const ks = calls.filter((c) => dayOf(c.at) === day);
      return {
        day,
        runs: rs.length,
        reached: rs.filter((r) => REACHED.has(r.outcome)).length,
        commands: rate(cs.length, cs.filter((c) => !c.ok).length),
        calls: rate(ks.length, ks.filter((c) => !c.ok).length),
      };
    });

  const steps = o.steps.filter((s) => inWindow(s.at) && siteOk(s.site));
  const models = o.models.filter((m) => inWindow(m.at));
  const runById = new Map(runs.map((r) => [r.run, r]));
  return {
    since: o.since,
    until: o.until,
    explore: {
      runs: runs.length,
      reached,
      failed: failedRuns,
      unknown: runs.length - reached - failedRuns,
      successRate: reached + failedRuns ? reached / (reached + failedRuns) : null,
      commands: rate(cmds.length, failedCmds.length),
      targetMiss: rate(acts.length, misses.length),
      byFailure: tally(
        failedCmds.map((c) => ({ kind: cmdFailure(c.error), error: c.error ?? "" })),
      ),
      byCmd,
      bySite,
      struggled: [...failsByRun]
        .filter(([, n]) => n >= STRUGGLE)
        .map(([run, failed]) => {
          const r = runById.get(run) as RunSummary;
          return { run, site: r.site, goal: r.goal, outcome: r.outcome, failed };
        })
        .sort((a, b) => b.failed - a.failed),
    },
    calls: {
      settled: rate(calls.length, calls.filter((c) => !c.ok).length),
      tries: rows.length,
      retried: calls.filter((c) => c.attempts > 1).length,
      byFailure: tally(
        calls.filter((c) => !c.ok).map((c) => ({ kind: callFailure(c), error: c.error ?? "" })),
      ),
      byRoute,
      imported: rows.filter((r) => r.from).length,
    },
    steps: rate(steps.length, steps.filter((s) => !s.ok).length),
    models: rate(models.length, models.filter((m) => !m.ok).length),
    days,
  };
}

const pct = (r: number) => `${(r * 100).toFixed(r && r < 0.1 ? 1 : 0)}%`;
const line = (label: string, r: Rate, width = 18) =>
  `${label.padEnd(width)} ${String(r.failed).padStart(5)} failed of ${String(r.n).padStart(6)}  ${pct(r.rate).padStart(5)}`;

export function formatSuccessReport(r: SuccessReport): string[] {
  const e = r.explore;
  const out = [
    `success ${r.since.slice(0, 10)} → ${r.until.slice(0, 10)}`,
    "",
    "explore runs",
    `  ${e.runs} runs: ${e.reached} reached, ${e.failed} failed, ${e.unknown} no verdict` +
      (e.successRate === null ? "" : `  → ${pct(e.successRate)} of runs with a verdict reached it`),
    `  ${line("commands", e.commands)}`,
    `  ${line("target misses", e.targetMiss)}  (of acts: the digest pointed wrong)`,
  ];
  if (e.byFailure.length) {
    out.push("  why commands failed");
    for (const f of e.byFailure)
      out.push(`    ${f.kind.padEnd(14)} ${String(f.n).padStart(5)}  ${f.example}`);
  }
  if (e.byCmd.length) {
    out.push("  by command");
    for (const c of e.byCmd.slice(0, 8)) out.push(`    ${line(c.cmd, c)}`);
  }
  if (e.bySite.length) {
    out.push("  by site                     runs reached no-verdict");
    for (const s of e.bySite.slice(0, 12))
      out.push(
        `    ${line(s.site, s)}  ${String(s.runs).padStart(4)} ${String(s.reached).padStart(7)} ${String(s.unknown).padStart(10)}`,
      );
  }
  if (e.struggled.length) {
    out.push(`  runs with ${STRUGGLE}+ failed commands: ${e.struggled.length}`);
    for (const s of e.struggled.slice(0, 10))
      out.push(
        `    ${String(s.failed).padStart(3)} ${s.outcome.padEnd(8)} ${s.site.padEnd(14)} ${s.run}  ${s.goal?.slice(0, 60) ?? ""}`,
      );
  }
  const c = r.calls;
  out.push(
    "",
    "site calls",
    `  ${line("calls", c.settled)}  (${c.tries} tries, ${c.retried} retried${c.imported ? `, ${c.imported} imported` : ""})`,
  );
  if (c.byFailure.length) {
    out.push("  why calls failed");
    for (const f of c.byFailure)
      out.push(`    ${f.kind.padEnd(14)} ${String(f.n).padStart(5)}  ${f.example}`);
  }
  if (c.byRoute.length) {
    out.push("  by route");
    for (const x of c.byRoute.slice(0, 12))
      out.push(`    ${line(`${x.site} ${x.route}`.slice(0, 44), x, 44)}  retried ${x.retried}`);
  }
  out.push("", `${line("agent steps", r.steps)}`, `${line("model calls", r.models)}`);
  if (r.days.length > 1) {
    out.push("", "by day        runs reached   cmds failed   calls failed");
    for (const d of r.days)
      out.push(
        `  ${d.day}  ${String(d.runs).padStart(4)} ${String(d.reached).padStart(7)}   ${String(d.commands.n).padStart(4)} ${pct(d.commands.rate).padStart(6)}   ${String(d.calls.n).padStart(5)} ${pct(d.calls.rate).padStart(6)}`,
      );
  }
  return out;
}
