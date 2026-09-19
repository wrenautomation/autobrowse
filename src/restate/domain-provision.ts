/**
 * `DomainProvision/{domain}`: one Virtual Object per domain, so two runs
 * for the same domain serialize and its state is in one place.
 *
 * Every handler is short. `step` runs one step and sends itself the next,
 * so between steps the object is free: `pause`, `reset`, `approve` never
 * queue behind a run for longer than one step. A gate is state, not a
 * parked invocation; `approve`/`reject` record the answer and send `step`.
 * A generation number stamps every chained `step`, so a message from a
 * run that was reset cannot move the run that replaced it.
 */
import * as restate from "@restatedev/restate-sdk";
import type { Effects, GateAnswer, GateName } from "../flow/effects.js";
import { type PlanInput, parsePlan } from "../flow/plan.js";
import {
  advance,
  applyAnswer,
  KEYS,
  type OpenGate,
  type Outcome,
  outcomeOf,
  summarize,
} from "../flow/run.js";
import type { Deps } from "../flow/steps.js";

const PLAN = "plan";
const OUTCOME = "outcome";
const PAUSED = "paused";
const GEN = "gen";

export interface ProvisionStatus {
  domain: string;
  plan: PlanInput | null;
  gate: OpenGate | null;
  paused: boolean;
  outcome: Outcome | null;
}

const SERVICE = { name: "DomainProvision" } as const;

function effects(ctx: restate.ObjectContext): Effects {
  return {
    run: (name, fn) => ctx.run(name, fn),
    get: (key) => ctx.get(key),
    set: (key, value) => ctx.set(key, value),
    clear: (key) => ctx.clear(key),
    sleep: (ms) => ctx.sleep(ms),
    now: async () => new Date(await ctx.date.now()),
  };
}

export function makeDomainProvision(deps: Deps) {
  /** Queue the next step for this generation. */
  const next = (ctx: restate.ObjectContext, gen: number) =>
    ctx.objectSendClient<DomainProvision>(SERVICE, ctx.key).step({ gen });

  const gateOpen = async (ctx: restate.ObjectContext, name: string): Promise<OpenGate> => {
    const gate = await ctx.get<OpenGate>(KEYS.gate);
    if (!gate) throw new restate.TerminalError(`no gate open for ${ctx.key}`);
    if (gate.name !== name)
      throw new restate.TerminalError(`the open gate is ${gate.name}, not ${name}`);
    return gate;
  };

  const answer = async (
    ctx: restate.ObjectContext,
    input: { name: string; note?: string },
    approved: boolean,
  ): Promise<OpenGate> => {
    const gate = await gateOpen(ctx, input.name);
    const a: GateAnswer = {
      approved,
      note: input.note ?? null,
      at: new Date(await ctx.date.now()).toISOString(),
    };
    const verdict = await applyAnswer(effects(ctx), gate, a);
    if (verdict === "rejected") ctx.set(OUTCOME, await outcomeOf(effects(ctx), "rejected"));
    else next(ctx, (await ctx.get<number>(GEN)) ?? 0);
    return gate;
  };

  return restate.object({
    name: SERVICE.name,
    handlers: {
      /** Start or resume the flow with `plan` (omit to reuse the stored one). Returns at once; watch `status`. */
      run: async (ctx: restate.ObjectContext, input: PlanInput | null): Promise<void> => {
        const stored = await ctx.get<PlanInput>(PLAN);
        const raw = input ?? stored;
        if (!raw) throw new restate.TerminalError("no plan given and none stored for this domain");
        parsePlan({ ...raw, domain: ctx.key });
        if (await ctx.get<OpenGate>(KEYS.gate))
          throw new restate.TerminalError(`${ctx.key} is waiting at a gate: approve or reject it`);
        ctx.set(PLAN, raw);
        ctx.clear(OUTCOME);
        const gen = ((await ctx.get<number>(GEN)) ?? 0) + 1;
        ctx.set(GEN, gen);
        next(ctx, gen);
      },

      /** One step, then the next. Internal: `run`, `play` and `approve` send it. */
      step: async (ctx: restate.ObjectContext, input: { gen: number }): Promise<void> => {
        const gen = (await ctx.get<number>(GEN)) ?? 0;
        const raw = await ctx.get<PlanInput>(PLAN);
        if (input.gen !== gen || !raw) return; // a message from a run that is gone
        if (await ctx.get<boolean>(PAUSED)) return; // `play` sends the next step
        const plan = parsePlan({ ...raw, domain: ctx.key });
        const fx = effects(ctx);
        const a = await advance(fx, deps, plan);
        if (a.kind === "continue") {
          next(ctx, gen);
          return;
        }
        if (a.kind === "waiting") {
          const g = a.gate;
          await ctx.run("notify gate", () =>
            deps.notify(
              `autobrowse ${ctx.key}: ${g.name === "human" ? `needs you at ${g.step}` : `approve ${g.name}?`}`,
              [
                g.prompt,
                g.screenshot ?? "",
                g.trace ? `trace: npx playwright show-trace ${g.trace}` : "",
                "",
                `autobrowse approve ${ctx.key} ${g.name}`,
                `autobrowse reject ${ctx.key} ${g.name}`,
              ]
                .filter((l) => l !== "")
                .join("\n"),
            ),
          );
          return;
        }
        const outcome = await outcomeOf(fx, a.status);
        ctx.set(OUTCOME, outcome);
        await ctx.run("notify finished", () =>
          deps.notify(`autobrowse ${ctx.key}: ${a.status}`, summarize(outcome)),
        );
      },

      /** Stop before the next step. A step in flight finishes first. */
      pause: async (ctx: restate.ObjectContext): Promise<void> => {
        ctx.set(PAUSED, true);
      },

      /** Undo `pause` and run on. */
      play: async (ctx: restate.ObjectContext): Promise<void> => {
        if (!(await ctx.get<boolean>(PAUSED))) return;
        ctx.clear(PAUSED);
        if (await ctx.get<OpenGate>(KEYS.gate)) return; // the answer will send the next step
        if (await ctx.get<Outcome>(OUTCOME)) return; // nothing left to run
        next(ctx, (await ctx.get<number>(GEN)) ?? 0);
      },

      approve: (ctx: restate.ObjectContext, input: { name: GateName; note?: string }) =>
        answer(ctx, input, true),

      reject: (ctx: restate.ObjectContext, input: { name: GateName; note?: string }) =>
        answer(ctx, input, false),

      /** Forget everything about this domain. A step in flight finishes first; its follow-up is ignored. */
      reset: async (ctx: restate.ObjectContext): Promise<void> => {
        const gen = (await ctx.get<number>(GEN)) ?? 0;
        ctx.clearAll();
        ctx.set(GEN, gen + 1);
      },

      status: restate.handlers.object.shared(
        async (ctx: restate.ObjectSharedContext): Promise<ProvisionStatus> => {
          const outcome = await ctx.get<Outcome>(OUTCOME);
          const gate = await ctx.get<OpenGate>(KEYS.gate);
          return {
            domain: ctx.key,
            plan: await ctx.get<PlanInput>(PLAN),
            gate,
            paused: (await ctx.get<boolean>(PAUSED)) === true,
            outcome: outcome ?? (await inFlight(ctx, gate)),
          };
        },
      ),
    },
  });
}

/** Mid-run status: the results so far, without a final verdict. */
async function inFlight(
  ctx: restate.ObjectSharedContext,
  gate: OpenGate | null,
): Promise<Outcome | null> {
  const results = await ctx.get<Outcome["results"]>(KEYS.results);
  if (!results) return null;
  return {
    status: gate ? "waiting" : "running",
    results,
    memo: (await ctx.get<Outcome["memo"]>(KEYS.memo)) ?? {},
  };
}

export { summarize };

export type DomainProvision = ReturnType<typeof makeDomainProvision>;
