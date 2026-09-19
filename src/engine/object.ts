/**
 * One Restate Virtual Object per workflow, one run per key. Every handler
 * is short. `step` runs one step and sends itself the next, so between
 * steps the object is free: `pause`, `reset`, `approve` never queue
 * behind a run for longer than one step. A gate is state, not a parked
 * invocation; `approve`/`reject` record the answer and send `step`. A
 * generation number stamps every chained `step`, so a message from a run
 * that was reset cannot move the run that replaced it.
 */
import * as restate from "@restatedev/restate-sdk";
import { FlowFailed } from "../browser/flow.js";
import { type Artifacts, NeedsHuman } from "../browser/session.js";
import { HttpError } from "../clients/http.js";
import type { DistributiveOmit } from "../types.js";
import { type Effects, type GateAnswer, type GateName, Unrecoverable } from "./effects.js";
import type { RunEvent, RunRef } from "./events.js";
import { REGISTRY, REGISTRY_KEY, type RunsRegistry } from "./registry.js";
import {
  advance,
  applyAnswer,
  KEYS,
  type OpenGate,
  type Outcome,
  outcomeOf,
  summarize,
} from "./run.js";
import type { AnyWorkflow, DepsOf, PlanOf } from "./workflow.js";

const PLAN = "plan";
const OUTCOME = "outcome";
const PAUSED = "paused";
const GEN = "gen";

export type EventBody = DistributiveOmit<RunEvent, "run" | "at">;

export interface RunStatusView {
  workflow: string;
  key: string;
  plan: unknown;
  gate: OpenGate | null;
  paused: boolean;
  outcome: Outcome | null;
}

/** What the host gives every run object besides the workflow's own deps. */
export interface HostDeps {
  /** Tell people and systems. Journaled per event; never throws the run. */
  emit(event: RunEvent): Promise<void>;
  /** Off in tests that run one object without the registry. */
  registry?: boolean;
}

/** Restate retries a failed `ctx.run` forever by default; this is what a step gets instead. */
const RETRY = {
  maxRetryAttempts: 6,
  initialRetryInterval: 1_000,
  retryIntervalFactor: 2,
  maxRetryInterval: 30_000,
};

/** Error codes that let the original error type survive the journal. */
const CODE = { needsHuman: 460, failed: 461 } as const;

/** Nothing a retry would fix: config, auth, a person needed, a flow that broke, a client error other than 429. */
function unrecoverable(err: unknown): boolean {
  if (err instanceof Unrecoverable || err instanceof NeedsHuman || err instanceof FlowFailed)
    return true;
  if (err instanceof HttpError) return err.status >= 400 && err.status < 500 && err.status !== 429;
  return false;
}

/**
 * Inside `ctx.run`, an unrecoverable error becomes a TerminalError so
 * Restate stops retrying; on the way out it becomes the original type
 * again (NeedsHuman with its artifacts, or a plain failure), replay
 * included, because the message is what the journal keeps.
 */
async function journaled<T>(
  ctx: restate.ObjectContext,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await ctx.run(
      name,
      async () => {
        try {
          return await fn();
        } catch (err) {
          if (!unrecoverable(err)) throw err;
          if (err instanceof NeedsHuman)
            throw new restate.TerminalError(
              JSON.stringify({ reason: err.message, artifacts: err.artifacts }),
              {
                errorCode: CODE.needsHuman,
              },
            );
          const artifacts = err instanceof FlowFailed ? err.artifacts : {};
          throw new restate.TerminalError(
            JSON.stringify({ reason: err instanceof Error ? err.message : String(err), artifacts }),
            { errorCode: CODE.failed },
          );
        }
      },
      RETRY,
    );
  } catch (err) {
    if (!(err instanceof restate.TerminalError)) throw err;
    if (err.code === CODE.needsHuman || err.code === CODE.failed) {
      const { reason, artifacts } = JSON.parse(err.message) as {
        reason: string;
        artifacts: Artifacts;
      };
      if (err.code === CODE.needsHuman) {
        const nh = new NeedsHuman(reason);
        nh.artifacts = artifacts;
        throw nh;
      }
      if (artifacts.screenshot || artifacts.trace) throw new FlowFailed(name, reason, artifacts);
      throw new Unrecoverable(reason);
    }
    // Retries exhausted: Restate's own terminal wrapper. The step fails with the last message.
    throw new Error(`${name}: ${err.message}`);
  }
}

function effects(ctx: restate.ObjectContext): Effects {
  return {
    run: (name, fn) => journaled(ctx, name, fn),
    get: (key) => ctx.get(key),
    set: (key, value) => ctx.set(key, value),
    clear: (key) => ctx.clear(key),
    sleep: (ms) => ctx.sleep(ms),
    now: async () => new Date(await ctx.date.now()),
  };
}

/** The run object's handlers as the ingress client sees them. */
export interface RunHandlers<P> {
  run(ctx: restate.ObjectContext, input: P | null): Promise<void>;
  step(ctx: restate.ObjectContext, input: { gen: number }): Promise<void>;
  pause(ctx: restate.ObjectContext): Promise<void>;
  play(ctx: restate.ObjectContext): Promise<void>;
  approve(ctx: restate.ObjectContext, input: { name: GateName; note?: string }): Promise<OpenGate>;
  reject(ctx: restate.ObjectContext, input: { name: GateName; note?: string }): Promise<OpenGate>;
  reset(ctx: restate.ObjectContext): Promise<void>;
  status(ctx: restate.ObjectSharedContext): Promise<RunStatusView>;
}

/** Pass this to `objectClient<RunObject<W>>`; the SDK derives the client from the handler map. */
export type RunObject<W extends AnyWorkflow> = RunHandlers<PlanOf<W>>;
export type RunObjectDefinition<W extends AnyWorkflow> = restate.VirtualObjectDefinition<
  string,
  RunObject<W>
>;

export function makeRunObject<W extends AnyWorkflow>(
  workflow: W,
  deps: DepsOf<W>,
  host: HostDeps,
): RunObjectDefinition<W> {
  const service = { name: workflow.name } as const;
  type Self = RunObject<W>;

  const emit = async (ctx: restate.ObjectContext, e: EventBody) => {
    const event = {
      ...e,
      run: { workflow: workflow.name, key: ctx.key } satisfies RunRef,
      at: new Date(await ctx.date.now()).toISOString(),
    } as RunEvent;
    if (host.registry !== false)
      ctx.objectSendClient<RunsRegistry>(REGISTRY, REGISTRY_KEY).record(event);
    await ctx.run(`emit ${event.type}`, () => host.emit(event).catch(() => undefined));
  };

  const next = (ctx: restate.ObjectContext, gen: number) =>
    ctx.objectSendClient<Self>(service, ctx.key).step({ gen });

  const gateOpen = async (ctx: restate.ObjectContext, name: string): Promise<OpenGate> => {
    const gate = await ctx.get<OpenGate>(KEYS.gate);
    if (!gate) throw new restate.TerminalError(`no gate open for ${workflow.name}/${ctx.key}`);
    if (gate.name !== name)
      throw new restate.TerminalError(`the open gate is ${gate.name}, not ${name}`);
    return gate;
  };

  const answer = async (
    ctx: restate.ObjectContext,
    input: { name: GateName; note?: string },
    approved: boolean,
  ): Promise<OpenGate> => {
    const gate = await gateOpen(ctx, input.name);
    const a: GateAnswer = {
      approved,
      note: input.note ?? null,
      at: new Date(await ctx.date.now()).toISOString(),
    };
    const fx = effects(ctx);
    const verdict = await applyAnswer(fx, gate, a);
    await emit(ctx, {
      type: "gate-answered",
      gate: gate.name,
      step: gate.step,
      approved,
      note: a.note,
    });
    if (verdict === "rejected") {
      const outcome = await outcomeOf(fx, workflow, "rejected");
      ctx.set(OUTCOME, outcome);
      await emit(ctx, { type: "finished", status: "rejected", summary: summarize(outcome) });
    } else next(ctx, (await ctx.get<number>(GEN)) ?? 0);
    return gate;
  };

  const object = restate.object({
    name: service.name,
    handlers: {
      /** Start or resume the run with `plan` (omit to reuse the stored one). Returns at once; watch `status`. */
      run: async (ctx: restate.ObjectContext, input: PlanOf<W> | null): Promise<void> => {
        const stored = await ctx.get<PlanOf<W>>(PLAN);
        const raw = input ?? stored;
        if (!raw) throw new restate.TerminalError("no plan given and none stored for this run");
        const parsed = workflow.plan.safeParse(raw);
        if (!parsed.success) throw new restate.TerminalError(`bad plan: ${parsed.error.message}`);
        if (await ctx.get<OpenGate>(KEYS.gate))
          throw new restate.TerminalError(`${ctx.key} is waiting at a gate: approve or reject it`);
        ctx.set(PLAN, raw);
        ctx.clear(OUTCOME);
        const gen = ((await ctx.get<number>(GEN)) ?? 0) + 1;
        ctx.set(GEN, gen);
        await emit(ctx, { type: "started" });
        next(ctx, gen);
      },

      /** One step, then the next. Internal: `run`, `play` and `approve` send it. */
      step: async (ctx: restate.ObjectContext, input: { gen: number }): Promise<void> => {
        const gen = (await ctx.get<number>(GEN)) ?? 0;
        const raw = await ctx.get<PlanOf<W>>(PLAN);
        if (input.gen !== gen || !raw) return; // a message from a run that is gone
        if (await ctx.get<boolean>(PAUSED)) return; // `play` sends the next step
        const plan = workflow.plan.parse(raw);
        const fx = effects(ctx);
        const a = await advance(fx, workflow, deps, plan);
        if (a.kind === "continue") {
          await emit(ctx, { type: "step", step: a.step, result: a.result });
          next(ctx, gen);
          return;
        }
        if (a.kind === "waiting") {
          await emit(ctx, { type: "gate-opened", gate: a.gate });
          return;
        }
        if (a.step && a.result) await emit(ctx, { type: "step", step: a.step, result: a.result });
        const outcome = await outcomeOf(fx, workflow, a.status);
        ctx.set(OUTCOME, outcome);
        await emit(ctx, { type: "finished", status: a.status, summary: summarize(outcome) });
      },

      /** Stop before the next step. A step in flight finishes first. */
      pause: async (ctx: restate.ObjectContext): Promise<void> => {
        if (await ctx.get<boolean>(PAUSED)) return;
        ctx.set(PAUSED, true);
        await emit(ctx, { type: "paused" });
      },

      /** Undo `pause` and run on. */
      play: async (ctx: restate.ObjectContext): Promise<void> => {
        if (!(await ctx.get<boolean>(PAUSED))) return;
        ctx.clear(PAUSED);
        await emit(ctx, { type: "resumed" });
        if (await ctx.get<OpenGate>(KEYS.gate)) return; // the answer will send the next step
        if (await ctx.get<Outcome>(OUTCOME)) return; // nothing left to run
        next(ctx, (await ctx.get<number>(GEN)) ?? 0);
      },

      approve: (ctx: restate.ObjectContext, input: { name: GateName; note?: string }) =>
        answer(ctx, input, true),

      reject: (ctx: restate.ObjectContext, input: { name: GateName; note?: string }) =>
        answer(ctx, input, false),

      /** Forget everything about this run. A step in flight finishes first; its follow-up is ignored. */
      reset: async (ctx: restate.ObjectContext): Promise<void> => {
        const gen = (await ctx.get<number>(GEN)) ?? 0;
        ctx.clearAll();
        ctx.set(GEN, gen + 1);
        await emit(ctx, { type: "reset" });
      },

      status: restate.handlers.object.shared(
        async (ctx: restate.ObjectSharedContext): Promise<RunStatusView> => {
          const outcome = await ctx.get<Outcome>(OUTCOME);
          const gate = await ctx.get<OpenGate>(KEYS.gate);
          return {
            workflow: workflow.name,
            key: ctx.key,
            plan: await ctx.get(PLAN),
            gate,
            paused: (await ctx.get<boolean>(PAUSED)) === true,
            outcome: outcome ?? (await inFlight(ctx, workflow, gate)),
          };
        },
      ),
    },
  });
  return object as unknown as RunObjectDefinition<W>;
}

/** Mid-run status: the results so far, without a final verdict. */
async function inFlight(
  ctx: restate.ObjectSharedContext,
  workflow: AnyWorkflow,
  gate: OpenGate | null,
): Promise<Outcome | null> {
  const results = await ctx.get<Outcome["results"]>(KEYS.results);
  if (!results) return null;
  return {
    status: gate ? "waiting" : "running",
    results,
    memo: (await ctx.get<Outcome["memo"]>(KEYS.memo)) ?? workflow.emptyMemo(),
  };
}
