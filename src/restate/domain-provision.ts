/**
 * `DomainProvision/{domain}`: one Virtual Object per domain, so two runs for
 * the same domain serialize and its state (results, memo, open gates) is
 * one place. `run` walks the flow; `approve`/`reject` answer whichever gate
 * it is parked at; `status` is shared and never waits.
 */
import * as restate from "@restatedev/restate-sdk";
import type { Effects, GateAnswer } from "../flow/effects.js";
import { type PlanInput, parsePlan } from "../flow/plan.js";
import { type Deps, MEMO, RESULTS, type RunOutcome, runFlow } from "../flow/steps.js";

const PLAN = "plan";
const GATE = "gate";
const OUTCOME = "outcome";
const CANCELLED = "cancelled";

export interface GateState {
  name: string;
  awakeableId: string;
  message: string;
  openedAt: string;
}

export interface ProvisionStatus {
  domain: string;
  plan: unknown;
  gate: GateState | null;
  outcome: RunOutcome | null;
}

function effects(ctx: restate.ObjectContext, deps: Deps): Effects {
  return {
    run: (name, fn) => ctx.run(name, fn),
    async gate(name, message) {
      const { id, promise } = ctx.awakeable<GateAnswer>();
      const openedAt = new Date(await ctx.date.now()).toISOString();
      ctx.set<GateState>(GATE, { name, awakeableId: id, message, openedAt });
      await ctx.run("notify gate", () =>
        deps.notify(
          `provision ${ctx.key}: approve ${name}?`,
          `${message}\n\nprovision approve ${ctx.key} ${name}\nprovision reject ${ctx.key} ${name}`,
        ),
      );
      let answer: GateAnswer;
      try {
        answer = await promise;
      } catch (err) {
        // `cancel` rejected the awakeable: the run ends as rejected and forgets itself.
        answer = {
          approved: false,
          note: `${CANCELLED}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      ctx.clear(GATE);
      return answer;
    },
    get: (key) => ctx.get(key),
    set: (key, value) => ctx.set(key, value),
    sleep: (ms) => ctx.sleep(ms),
    now: async () => new Date(await ctx.date.now()),
  };
}

export function makeDomainProvision(deps: Deps) {
  return restate.object({
    name: "DomainProvision",
    handlers: {
      /** Start or resume the flow for this domain with `plan` (omit to reuse the stored one). */
      run: async (ctx: restate.ObjectContext, input: PlanInput | null): Promise<RunOutcome> => {
        const stored = await ctx.get<PlanInput>(PLAN);
        const raw = input ?? stored;
        if (!raw) throw new restate.TerminalError("no plan given and none stored for this domain");
        const plan = parsePlan({ ...raw, domain: ctx.key });
        ctx.set(PLAN, raw);
        const outcome = await runFlow(effects(ctx, deps), deps, plan);
        if (outcome.status === "rejected" && wasCancelled(outcome)) {
          ctx.clearAll();
          return outcome;
        }
        ctx.set(OUTCOME, outcome);
        if (outcome.status === "done") {
          await ctx.run("notify done", () =>
            deps.notify(`provision ${ctx.key}: done`, summarize(outcome)),
          );
        }
        return outcome;
      },

      /**
       * Forget a finished run so the next `run` starts over. Exclusive, so it
       * queues behind a run in flight: `cancel` that one first.
       */
      reset: async (ctx: restate.ObjectContext): Promise<void> => {
        ctx.clearAll();
      },

      /** End a run parked at a gate; it forgets itself on the way out. No-op when nothing is parked. */
      cancel: restate.handlers.object.shared(
        async (
          ctx: restate.ObjectSharedContext,
          input: { note?: string } | null,
        ): Promise<boolean> => {
          const gate = await ctx.get<GateState>(GATE);
          if (!gate) return false;
          ctx.rejectAwakeable(gate.awakeableId, input?.note ?? "cancelled by operator");
          return true;
        },
      ),

      approve: restate.handlers.object.shared(
        async (
          ctx: restate.ObjectSharedContext,
          input: { name: string; note?: string },
        ): Promise<GateState> =>
          answer(ctx, input.name, { approved: true, note: input.note ?? null }),
      ),

      reject: restate.handlers.object.shared(
        async (
          ctx: restate.ObjectSharedContext,
          input: { name: string; note?: string },
        ): Promise<GateState> =>
          answer(ctx, input.name, { approved: false, note: input.note ?? null }),
      ),

      status: restate.handlers.object.shared(
        async (ctx: restate.ObjectSharedContext): Promise<ProvisionStatus> => ({
          domain: ctx.key,
          plan: await ctx.get(PLAN),
          gate: await ctx.get<GateState>(GATE),
          outcome: (await ctx.get<RunOutcome>(OUTCOME)) ?? (await partial(ctx)),
        }),
      ),
    },
  });
}

async function answer(
  ctx: restate.ObjectSharedContext,
  name: string,
  a: GateAnswer,
): Promise<GateState> {
  const gate = await ctx.get<GateState>(GATE);
  if (!gate) throw new restate.TerminalError(`no gate open for ${ctx.key}`);
  if (gate.name !== name)
    throw new restate.TerminalError(`the open gate is ${gate.name}, not ${name}`);
  ctx.resolveAwakeable(gate.awakeableId, a);
  return gate;
}

/** Mid-run status: the results so far, without an overall verdict. */
async function partial(ctx: restate.ObjectSharedContext): Promise<RunOutcome | null> {
  const results = await ctx.get<RunOutcome["results"]>(RESULTS);
  if (!results) return null;
  return { status: "planned", results, memo: (await ctx.get<RunOutcome["memo"]>(MEMO)) ?? {} };
}

function wasCancelled(outcome: RunOutcome): boolean {
  return Object.values(outcome.results).some(
    (r) => r.status === "rejected" && r.detail.startsWith(CANCELLED),
  );
}

export function summarize(outcome: RunOutcome): string {
  const lines = Object.entries(outcome.results).map(
    ([name, r]) => `${r.status.padEnd(11)} ${name}: ${r.detail}`,
  );
  return `${outcome.status}\n${lines.join("\n")}`;
}

export type DomainProvision = ReturnType<typeof makeDomainProvision>;
