/**
 * A workflow is an ordered list of steps over a validated plan. Steps are
 * idempotent (get before create), pass what later steps need through the
 * memo, and say whether they are irreversible so a dry run stops before
 * them and a person can be asked first. `run.ts` walks them; `object.ts`
 * hosts one run per key on Restate.
 *
 * `defineWorkflow<Deps, Memo>()({...})` is the library surface: a new
 * chore is a plan schema, a deps type and a list of steps. Step names are
 * inferred as a literal union, so results are typed per workflow.
 */
import type { z } from "zod";
import type { Effects, GateAnswer, GateName } from "./effects.js";

/** What one step returns. The host adds `at` and the artifacts. */
export type StepOutput =
  | { status: "done"; detail: string }
  | { status: "skipped"; detail: string }
  | { status: "rejected"; detail: string };

export const done = (detail: string): StepOutput => ({ status: "done", detail });
export const skipped = (detail: string): StepOutput => ({ status: "skipped", detail });
export const rejected = (detail: string): StepOutput => ({ status: "rejected", detail });

export interface StepCtx<P, D, M> {
  fx: Effects;
  deps: D;
  plan: P;
  memo: M;
  /** The recorded answer, or `GateOpen` so the host can ask. */
  gate(name: GateName, prompt: string): GateAnswer;
}

export interface StepDef<P, D, M, S extends string = string> {
  name: S;
  /** Spends money, creates an account, or does something a person would have to undo. */
  irreversible?: boolean;
  run(ctx: StepCtx<P, D, M>): Promise<StepOutput>;
}

/** Every plan carries these; the CLI and the engine read them. */
export interface PlanBase {
  /** Plan every step, do nothing irreversible; stop before the first one. */
  dryRun: boolean;
}

export interface Workflow<P extends PlanBase, D, M, S extends string = string> {
  /** The Restate object name and the CLI verb. */
  name: string;
  description: string;
  plan: z.ZodType<P>;
  steps: ReadonlyArray<StepDef<P, D, M, S>>;
  emptyMemo(): M;
}

/** Any workflow, for hosts that do not care about the types. */
// biome-ignore lint/suspicious/noExplicitAny: erased on purpose at the host boundary
export type AnyWorkflow = Workflow<any, any, any, string>;

export type StepNames<W> = W extends Workflow<infer _P, infer _D, infer _M, infer S> ? S : never;
export type PlanOf<W> = W extends Workflow<infer P, infer _D, infer _M, infer _S> ? P : never;
export type DepsOf<W> = W extends Workflow<infer _P, infer D, infer _M, infer _S> ? D : never;
export type MemoOf<W> = W extends Workflow<infer _P, infer _D, infer M, infer _S> ? M : never;

/**
 * Two calls: deps and memo cannot be inferred from the steps, the plan and
 * the step names can. `defineWorkflow<Deps, Memo>()({ ... })`.
 */
export function defineWorkflow<D, M>() {
  return <P extends PlanBase, const S extends string>(
    w: Workflow<P, D, M, S>,
  ): Workflow<P, D, M, S> => {
    const seen = new Set<string>();
    for (const s of w.steps) {
      if (seen.has(s.name)) throw new Error(`workflow ${w.name}: step ${s.name} defined twice`);
      seen.add(s.name);
    }
    if (!/^[a-z][a-z0-9-]*$/.test(w.name))
      throw new Error(`workflow name must be kebab-case, got ${w.name}`);
    return w;
  };
}

/** A step body with the workflow's types filled in, for files that define steps apart from the workflow. */
export type StepOf<W> = StepDef<PlanOf<W>, DepsOf<W>, MemoOf<W>, StepNames<W>>;
