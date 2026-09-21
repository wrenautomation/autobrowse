/**
 * One verb: `do("upload this to youtube", {file})`. The request is routed
 * to a site route, a compiled workflow or a hand-written flow that does it,
 * and run. When nothing does it yet, the agent explores the site toward the
 * goal once; what it achieved is saved and compiled, under the missing
 * leg's name when a route was waiting on one, so the next same ask is
 * deterministic. Gates hold inside every leg: a purchase or a publish the
 * caller did not gate still waits for a person.
 */
import { settleSession } from "../agent/builder.js";
import type { AgentSessions } from "../agent/sessions.js";
import type { Llm, LlmUsage } from "../llm/index.js";
import type { CompiledRun } from "../sites/facade.js";
import type { Method } from "../sites/types.js";
import { type Ability, parseSiteAbility } from "./catalog.js";
import { pickAbility } from "./pick.js";

export interface DoRequest {
  goal: string;
  /** Named values the goal may use: a file path, a title, a domain. */
  inputs?: Record<string, string>;
  /** The site profile to work in; found from the goal when absent. */
  site?: string | null;
  /** Where the agent starts when it explores. */
  url?: string | null;
  /** Route only: say what would run and with what, run nothing. */
  dryRun?: boolean;
}

export type DoVia = "site" | "workflow" | "flow" | "agent" | "none";

export interface DoOutcome {
  via: DoVia;
  /** The ability that ran, or the workflow the agent's run compiled into. */
  name: string | null;
  input: Record<string, unknown>;
  /** What the leg answered: the API's body, the workflow's read, the agent's summary. */
  output: unknown;
  status: "done" | "needs-human" | "failed" | "planned";
  /** A workflow compiled from this run, for the next same ask. */
  built: string | null;
  /** The agent session, when one ran (open on `needs-human`). */
  session: string | null;
  summary: string;
  usage: LlmUsage;
}

export class DoError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DoError";
  }
}

export interface DoerDeps {
  llm: Llm | null;
  abilities(): Promise<Ability[]>;
  /** Sites with a login, where the agent can work signed in. */
  sites(): Promise<string[]>;
  callSite(
    site: string,
    method: Method,
    path: string,
    input: Record<string, unknown>,
  ): Promise<unknown>;
  runWorkflow(name: string, plan: Record<string, unknown>): Promise<CompiledRun>;
  runFlow(name: string, input: unknown): Promise<unknown>;
  agent?: AgentSessions;
  /** Compile the recording saved under `name`; returns the workflow's name. */
  compile?(name: string): Promise<{ workflow: string }>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface Doer {
  do(req: DoRequest): Promise<DoOutcome>;
}

/** `workflow x not recorded` → `x`: the name a route's browser leg waits under. */
export function missingWorkflowName(missing: string | null): string | null {
  const m = missing ? /^workflow ([a-z0-9-]+) not recorded$/.exec(missing) : null;
  return m ? (m[1] as string) : null;
}

/** `Upload This To YouTube!` → `upload-this-to-youtube`, a recording name. */
export function recordingNameOf(goal: string): string {
  const s = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return /^[a-z]/.test(s) ? s : `do-${s || "goal"}`;
}

export function doer(d: DoerDeps): Doer {
  const runAbility = async (
    a: Ability,
    input: Record<string, unknown>,
  ): Promise<Pick<DoOutcome, "output" | "status" | "summary">> => {
    if (a.kind === "site") {
      const p = parseSiteAbility(a.name);
      if (!p) throw new DoError(500, `bad site ability ${a.name}`);
      const output = await d.callSite(p.site, p.method as Method, p.path, input);
      return { output, status: "done", summary: `${a.name} answered` };
    }
    if (a.kind === "workflow") {
      const run = await d.runWorkflow(a.name, input);
      const last = run.steps.at(-1);
      return {
        output: run.output ?? last?.detail ?? null,
        status:
          run.status === "done" ? "done" : run.status === "waiting" ? "needs-human" : "failed",
        summary: `${a.name} ${run.status}${last ? `: ${last.name} ${last.status}` : ""}`,
      };
    }
    const output = await d.runFlow(a.name, input);
    return { output, status: "done", summary: `${a.name} ran` };
  };

  /** The agent explores once; achieved → saved and compiled under `saveAs`. */
  const explore = async (
    req: DoRequest,
    site: string,
    saveAs: string,
    why: string,
    usage: LlmUsage,
  ): Promise<DoOutcome> => {
    if (!d.agent)
      throw new DoError(
        501,
        `nothing does "${req.goal}" yet and there is no model to explore it (${why})`,
      );
    const started = await d.agent.start({
      site,
      goal: req.goal,
      inputs: req.inputs ?? {},
      url: req.url ?? null,
    });
    const view = await settleSession(
      { agent: d.agent, ...(d.sleep ? { sleep: d.sleep } : {}), ...(d.now ? { now: d.now } : {}) },
      started.id,
    );
    const base = {
      via: "agent" as const,
      name: null,
      input: req.inputs ?? {},
      session: view.id,
      usage,
    };
    if (view.status === "needs-human")
      return {
        ...base,
        output: null,
        status: "needs-human",
        built: null,
        summary: `the agent needs you: ${view.prompt ?? "see the session"}`,
      };
    if (view.status === "done" && view.achieved) {
      let built: string | null = null;
      if (d.compile) {
        await d.agent.save(view.id, saveAs);
        await d.agent.close(view.id);
        built = (await d.compile(saveAs).catch(() => ({ workflow: null as string | null })))
          .workflow;
      } else await d.agent.close(view.id);
      return {
        ...base,
        name: built,
        output: view.summary,
        status: "done",
        built,
        summary: built
          ? `${view.summary ?? "done"}; compiled as ${built} for next time`
          : (view.summary ?? "done"),
      };
    }
    await d.agent.close(view.id).catch(() => undefined);
    return {
      ...base,
      output: null,
      status: "failed",
      built: null,
      summary: view.error ?? view.summary ?? `session ${view.status}`,
    };
  };

  return {
    async do(req) {
      if (!req.goal.trim()) throw new DoError(400, "an empty goal");
      const [abilities, sites] = await Promise.all([d.abilities(), d.sites()]);
      const pick = await pickAbility(
        d.llm,
        { goal: req.goal, inputs: req.inputs ?? {}, site: req.site ?? null },
        abilities,
        sites,
      );
      const a = pick.ability;
      if (req.dryRun)
        return {
          via: a ? (a.ready ? a.kind : "agent") : "agent",
          name: a?.name ?? null,
          input: pick.input,
          output: null,
          status: "planned",
          built: null,
          session: null,
          summary: a
            ? a.ready
              ? `would run ${a.name}: ${pick.why}`
              : `${a.name} is not ready (${a.missing}); the agent would build it on ${pick.site}`
            : `nothing does this yet; the agent would explore ${pick.site}`,
          usage: pick.usage,
        };
      if (a?.ready) {
        const ran = await runAbility(a, pick.input);
        return {
          via: a.kind,
          name: a.name,
          input: pick.input,
          ...ran,
          built: null,
          session: null,
          usage: pick.usage,
        };
      }
      // Nothing ready: the agent, saving under the leg's own name when a route waits on it.
      const saveAs = missingWorkflowName(a?.missing ?? null) ?? recordingNameOf(req.goal);
      return explore(req, pick.site, saveAs, pick.why, pick.usage);
    },
  };
}
