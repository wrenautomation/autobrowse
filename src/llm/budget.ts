/**
 * A daily token cap around any `Llm`, for a worker that runs unattended:
 * the agent, the evaluator, the builder and the compiler all spend
 * through it. Over the cap, a call fails with `BudgetExceeded` and the
 * caller reports it like any other failure; nothing waits. The ledger is
 * one small JSON file so every process on the machine (worker, CLI)
 * counts against the same day, which is a UTC day.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Llm, LlmReply, LlmRequest, LlmUsage } from "./types.js";

export interface DayLedger {
  day: string;
  inputTokens: number;
  outputTokens: number;
}

export interface Ledger {
  read(): DayLedger | null;
  write(l: DayLedger): void;
}

export class BudgetExceeded extends Error {
  constructor(
    readonly used: number,
    readonly cap: number,
  ) {
    super(
      `model budget: ${used} of ${cap} tokens used today; resets at UTC midnight, or raise LLM_DAILY_TOKENS`,
    );
    this.name = "BudgetExceeded";
  }
}

export interface BudgetedLlm extends Llm {
  readonly cap: number;
  /** Tokens (in + out) spent today across every process sharing the ledger. */
  usedToday(): number;
}

export const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

export function memoryLedger(init: DayLedger | null = null): Ledger {
  let l = init;
  return {
    read: () => l,
    write: (n) => {
      l = n;
    },
  };
}

/** Read on every call, written atomically: two processes may share it and a torn file reads as empty. */
export function fileLedger(path: string): Ledger {
  return {
    read() {
      try {
        const v = JSON.parse(readFileSync(path, "utf8")) as Partial<DayLedger>;
        if (typeof v.day !== "string") return null;
        return { day: v.day, inputTokens: v.inputTokens ?? 0, outputTokens: v.outputTokens ?? 0 };
      } catch {
        return null;
      }
    },
    write(l) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(l));
      renameSync(tmp, path);
    },
  };
}

export function budgetedLlm(
  inner: Llm,
  o: {
    dailyTokens: number;
    ledger: Ledger;
    now?: () => Date;
    /** Told once per day, the first time a call is refused: the person should hear it. */
    onExceeded?: (err: BudgetExceeded) => void;
  },
): BudgetedLlm {
  const now = o.now ?? (() => new Date());
  let toldFor: string | null = null;
  const today = (): DayLedger => {
    const l = o.ledger.read();
    const day = dayOf(now());
    return l && l.day === day ? l : { day, inputTokens: 0, outputTokens: 0 };
  };
  const used = (l: DayLedger) => l.inputTokens + l.outputTokens;
  const add = (usage: LlmUsage) => {
    const l = today();
    o.ledger.write({
      day: l.day,
      inputTokens: l.inputTokens + usage.inputTokens,
      outputTokens: l.outputTokens + usage.outputTokens,
    });
  };
  return {
    id: inner.id,
    cap: o.dailyTokens,
    usedToday: () => used(today()),
    async complete(req: LlmRequest): Promise<LlmReply> {
      const l = today();
      const before = used(l);
      if (before >= o.dailyTokens) {
        const err = new BudgetExceeded(before, o.dailyTokens);
        if (toldFor !== l.day) {
          toldFor = l.day;
          o.onExceeded?.(err);
        }
        throw err;
      }
      const reply = await inner.complete(req);
      add(reply.usage);
      return reply;
    },
  };
}
