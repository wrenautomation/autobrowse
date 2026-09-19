/**
 * Drives the steps one at a time. `advance` runs the next step that is not
 * done and says what happened; the host (Restate object, or the test loop)
 * calls it again until it is finished or waiting on a person. Everything
 * it knows lives in host state under four keys, so a new invocation, or a
 * restart, picks up where the last one stopped.
 */
import { FlowFailed } from "../browser/flow.js";
import { NeedsHuman } from "../browser/session.js";
import { type Effects, type GateAnswer, type GateName, GateOpen } from "./effects.js";
import type { Plan } from "./plan.js";
import { type Deps, IRREVERSIBLE, type Memo, STEPS, type StepName, steps } from "./steps.js";

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

export type Results = Partial<Record<StepName, StepResult>>;
export type Answers = Partial<Record<GateName, GateAnswer>>;

/** A gate a person has to answer; `step` is the one that asked. */
export interface OpenGate {
  name: GateName;
  step: StepName;
  prompt: string;
  openedAt: string;
  screenshot?: string;
  trace?: string;
}

export type Advance =
  | { kind: "continue"; step: StepName }
  | { kind: "waiting"; gate: OpenGate }
  | { kind: "finished"; status: "done" | "planned" | "rejected" | "failed" };

export interface Outcome {
  status: "running" | "done" | "planned" | "waiting" | "rejected" | "failed";
  results: Results;
  memo: Memo;
}

/**
 * The first step still to run, or null when the flow is complete. A step
 * that failed, needed a person, or was only planned runs again on the next
 * pass; a rejected one ends the flow until `reset`.
 */
export function nextStep(results: Results): StepName | null {
  for (const name of STEPS) {
    const r = results[name];
    if (!r) return name;
    if (r.status === "rejected") return null;
    if (r.status !== "done" && r.status !== "skipped") return name;
  }
  return null;
}

async function load(fx: Effects) {
  return {
    results: (await fx.get<Results>(KEYS.results)) ?? {},
    memo: (await fx.get<Memo>(KEYS.memo)) ?? {},
    answers: (await fx.get<Answers>(KEYS.answers)) ?? {},
  };
}

/** Run one step. Each call is one host invocation, so state is saved before it returns. */
export async function advance(fx: Effects, deps: Deps, plan: Plan): Promise<Advance> {
  const open = await fx.get<OpenGate>(KEYS.gate);
  if (open) return { kind: "waiting", gate: open };
  const { results, memo, answers } = await load(fx);
  const name = nextStep(results);
  if (name === null) return { kind: "finished", status: finalStatus(results) };
  const now = await fx.now();
  const at = now.toISOString();
  const save = () => {
    fx.set(KEYS.results, results);
    fx.set(KEYS.memo, memo);
  };
  if (plan.dryRun && IRREVERSIBLE.has(name)) {
    results[name] = {
      status: "planned",
      detail: "dry run stops before the first irreversible step",
      at,
    };
    save();
    return { kind: "finished", status: "planned" };
  }
  try {
    const out = await steps[name]({
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
    results[name] = { ...out, at };
    save();
    if (out.status === "rejected") return { kind: "finished", status: "rejected" };
    return { kind: "continue", step: name };
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
    return { kind: "finished", status: "failed" };
  }
}

/**
 * Record a person's answer to the open gate. A `purchase` answer is kept
 * for the step to read; a `human` approve retries the step (nothing to
 * read: the person did the thing); any reject ends the run. Returns
 * whether the flow should run on.
 */
export async function applyAnswer(
  fx: Effects,
  gate: OpenGate,
  answer: GateAnswer,
): Promise<"continue" | "rejected"> {
  const { results, answers } = await load(fx);
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
  return Object.values(results).some((r) => r.status === "rejected") ? "rejected" : "done";
}

export async function outcomeOf(fx: Effects, status: Outcome["status"]): Promise<Outcome> {
  const { results, memo } = await load(fx);
  return { status, results, memo };
}

/**
 * Run to the end in one process: the test host, and any caller that can
 * answer gates itself. `answer` is asked for every gate; a missing answer
 * leaves the flow waiting.
 */
export async function runFlow(
  fx: Effects,
  deps: Deps,
  plan: Plan,
  answer: (gate: OpenGate) => GateAnswer | null = () => null,
): Promise<Outcome> {
  for (;;) {
    const a = await advance(fx, deps, plan);
    if (a.kind === "continue") continue;
    if (a.kind === "finished") return outcomeOf(fx, a.status);
    const given = answer(a.gate);
    if (!given) return outcomeOf(fx, "waiting");
    if ((await applyAnswer(fx, a.gate, given)) === "rejected") return outcomeOf(fx, "rejected");
  }
}

export function summarize(outcome: Outcome): string {
  const lines = Object.entries(outcome.results).map(
    ([name, r]) => `${r.status.padEnd(11)} ${name}: ${r.detail}`,
  );
  return `${outcome.status}\n${lines.join("\n")}`;
}
