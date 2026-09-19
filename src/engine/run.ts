/**
 * Drives one workflow one step at a time. `advance` runs the next step
 * that is not done and says what happened; the host (Restate object, or
 * the test loop) calls it again until it is finished or waiting on a
 * person. Everything it knows lives in host state under four keys, so a
 * new invocation, or a restart, picks up where the last one stopped.
 */
import { FlowFailed } from "../browser/flow.js";
import { NeedsHuman } from "../browser/session.js";
import { type Effects, type GateAnswer, type GateName, GateOpen } from "./effects.js";
import type { AnyWorkflow, PlanBase, StepNames, Workflow } from "./workflow.js";

export const KEYS = {
  results: "results",
  memo: "memo",
  answers: "answers",
  gate: "gate",
} as const;

export type StepStatus = "done" | "skipped" | "planned" | "needs-human" | "rejected" | "failed";

export interface StepResult {
  status: StepStatus;
  detail: string;
  at: string;
  /** Where to look when a browser step went wrong. */
  screenshot?: string;
  trace?: string;
}

export type Results<S extends string = string> = Partial<Record<S, StepResult>>;
export type Answers = Partial<Record<GateName, GateAnswer>>;

/** A gate a person has to answer; `step` is the one that asked. */
export interface OpenGate {
  name: GateName;
  step: string;
  prompt: string;
  openedAt: string;
  screenshot?: string;
  trace?: string;
}

export type RunStatus = "running" | "done" | "planned" | "waiting" | "rejected" | "failed";
export type FinalStatus = Extract<RunStatus, "done" | "planned" | "rejected" | "failed">;

export type Advance<S extends string = string> =
  | { kind: "continue"; step: S; result: StepResult }
  | { kind: "waiting"; gate: OpenGate }
  | { kind: "finished"; status: FinalStatus; step?: S; result?: StepResult };

export interface Outcome<S extends string = string, M = unknown> {
  status: RunStatus;
  results: Results<S>;
  memo: M;
}

/**
 * The first step still to run, or null when the flow is complete. A step
 * that failed, needed a person, or was only planned runs again on the next
 * pass; a rejected one ends the flow until `reset`.
 */
export function nextStep<W extends AnyWorkflow>(
  workflow: W,
  results: Results<StepNames<W>>,
): StepNames<W> | null {
  for (const s of workflow.steps) {
    const name = s.name as StepNames<W>;
    const r = results[name];
    if (!r) return name;
    if (r.status === "rejected") return null;
    if (r.status !== "done" && r.status !== "skipped") return name;
  }
  return null;
}

async function load<M, S extends string>(
  fx: Effects,
  workflow: Pick<Workflow<PlanBase, unknown, M, S>, "emptyMemo">,
): Promise<{ results: Results<S>; memo: M; answers: Answers }> {
  return {
    results: (await fx.get<Results<S>>(KEYS.results)) ?? {},
    memo: (await fx.get<M>(KEYS.memo)) ?? workflow.emptyMemo(),
    answers: (await fx.get<Answers>(KEYS.answers)) ?? {},
  };
}

/** Run one step. Each call is one host invocation, so state is saved before it returns. */
export async function advance<P extends PlanBase, D, M, S extends string>(
  fx: Effects,
  workflow: Workflow<P, D, M, S>,
  deps: D,
  plan: P,
): Promise<Advance<S>> {
  const open = await fx.get<OpenGate>(KEYS.gate);
  if (open) return { kind: "waiting", gate: open };
  const { results, memo, answers } = await load<M, S>(fx, workflow);
  const name = nextStep(workflow, results);
  if (name === null) return { kind: "finished", status: finalStatus(results) };
  const step = workflow.steps.find((s) => s.name === name);
  if (!step) throw new Error(`workflow ${workflow.name} has no step ${name}`);
  const at = (await fx.now()).toISOString();
  const save = () => {
    fx.set(KEYS.results, results);
    fx.set(KEYS.memo, memo);
  };
  if (plan.dryRun && step.irreversible) {
    results[name] = {
      status: "planned",
      detail: "dry run stops before the first irreversible step",
      at,
    };
    save();
    return { kind: "finished", status: "planned", step: name, result: results[name] };
  }
  try {
    const out = await step.run({
      fx,
      deps,
      plan,
      memo,
      gate(gate, prompt) {
        const answer = answers[gate];
        if (!answer) throw new GateOpen(gate, prompt);
        return answer;
      },
    });
    const result: StepResult = { ...out, at };
    results[name] = result;
    save();
    if (out.status === "rejected") return { kind: "finished", status: "rejected" };
    return { kind: "continue", step: name, result };
  } catch (err) {
    if (err instanceof GateOpen) {
      const gate: OpenGate = { name: err.gate, step: name, prompt: err.prompt, openedAt: at };
      fx.set(KEYS.gate, gate);
      save();
      return { kind: "waiting", gate };
    }
    if (err instanceof NeedsHuman) {
      const gate: OpenGate = {
        name: "human",
        step: name,
        prompt: err.message,
        openedAt: at,
        ...err.artifacts,
      };
      results[name] = { status: "needs-human", detail: err.message, at, ...err.artifacts };
      fx.set(KEYS.gate, gate);
      save();
      return { kind: "waiting", gate };
    }
    const artifacts = err instanceof FlowFailed ? err.artifacts : {};
    results[name] = {
      status: "failed",
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      at,
      ...artifacts,
    };
    save();
    return { kind: "finished", status: "failed", step: name, result: results[name] };
  }
}

/**
 * Record a person's answer to the open gate. A `purchase` answer is kept
 * for the step to read; a `human` approve retries the step (nothing to
 * read: the person did the thing); any reject ends the run.
 */
export async function applyAnswer(
  fx: Effects,
  gate: OpenGate,
  answer: GateAnswer,
): Promise<"continue" | "rejected"> {
  const results = (await fx.get<Results>(KEYS.results)) ?? {};
  const answers = (await fx.get<Answers>(KEYS.answers)) ?? {};
  fx.clear(KEYS.gate);
  if (!answer.approved) {
    results[gate.step] = { status: "rejected", detail: answer.note ?? "declined", at: answer.at };
    fx.set(KEYS.results, results);
    return "rejected";
  }
  if (gate.name === "human") {
    delete results[gate.step];
    fx.set(KEYS.results, results);
  } else {
    answers[gate.name] = answer;
    fx.set(KEYS.answers, answers);
  }
  return "continue";
}

/** With no step left to run, the flow is done unless a person said no. */
export function finalStatus(results: Results): "done" | "rejected" {
  return Object.values(results).some((r) => r?.status === "rejected") ? "rejected" : "done";
}

export async function outcomeOf<P extends PlanBase, D, M, S extends string>(
  fx: Effects,
  workflow: Workflow<P, D, M, S>,
  status: RunStatus,
): Promise<Outcome<S, M>> {
  const { results, memo } = await load<M, S>(fx, workflow);
  return { status, results, memo };
}

/**
 * Run to the end in one process: the test host, and any caller that can
 * answer gates itself. `answer` is asked for every gate; a missing answer
 * leaves the flow waiting.
 */
export async function runFlow<P extends PlanBase, D, M, S extends string>(
  fx: Effects,
  workflow: Workflow<P, D, M, S>,
  deps: D,
  plan: P,
  answer: (gate: OpenGate) => GateAnswer | null = () => null,
): Promise<Outcome<S, M>> {
  for (;;) {
    const a = await advance(fx, workflow, deps, plan);
    if (a.kind === "continue") continue;
    if (a.kind === "finished") return outcomeOf(fx, workflow, a.status);
    const given = answer(a.gate);
    if (!given) return outcomeOf(fx, workflow, "waiting");
    if ((await applyAnswer(fx, a.gate, given)) === "rejected")
      return outcomeOf(fx, workflow, "rejected");
  }
}

export function summarize(outcome: Outcome): string {
  const lines = Object.entries(outcome.results).map(
    ([name, r]) => `${(r as StepResult).status.padEnd(11)} ${name}: ${(r as StepResult).detail}`,
  );
  return `${outcome.status}\n${lines.join("\n")}`;
}
