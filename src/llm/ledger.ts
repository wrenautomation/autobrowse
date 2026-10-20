/**
 * Every model call, one line: what it was for, which model, the tokens and
 * the time. `countedLlm` wraps any `Llm`; the rows go to one file per month
 * (`llm-2026-09.jsonl`), so the log stays bounded and a report reads only
 * the months it covers. Plain appends, not a chain: several processes write
 * here at once and a line under 4 KB lands whole. Never a prompt or a reply.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Llm, LlmReply, LlmRequest } from "./types.js";

export interface LlmCall {
  at: string;
  model: string;
  /** From `LlmRequest.purpose`; `unlabeled` when the caller gave none. */
  purpose: string;
  /** Every input token, cached ones included; `cachedTokens` says how many were cache reads. */
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  ms: number;
  ok: boolean;
  images: number;
  promptChars: number;
}

export interface LlmCalls {
  record(c: LlmCall): void;
}

const monthOf = (iso: string): string => iso.slice(0, 7);

export function fileLlmCalls(dir: string): LlmCalls {
  return {
    record(c) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        appendFileSync(join(dir, `llm-${monthOf(c.at)}.jsonl`), `${JSON.stringify(c)}\n`, {
          mode: 0o600,
        });
      } catch {
        // A full disk never fails the call it counts.
      }
    },
  };
}

export function memoryLlmCalls(): LlmCalls & { rows: LlmCall[] } {
  const rows: LlmCall[] = [];
  return { rows, record: (c) => rows.push(c) };
}

/** Calls since `since` (ISO), oldest first, from the month files that can hold them. */
export function readLlmCalls(dir: string, since: string): LlmCall[] {
  if (!existsSync(dir)) return [];
  const from = monthOf(since);
  const out: LlmCall[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = /^llm-(\d{4}-\d{2})\.jsonl$/.exec(f);
    if (!m || (m[1] as string) < from) continue;
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const c = JSON.parse(line) as LlmCall;
        if (c.at >= since) out.push(c);
      } catch {
        // torn
      }
    }
  }
  return out;
}

/** Tokens counted under one `tallied` run: what a flow run spent, whatever model it used. */
export interface LlmTally {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

const tallies = new AsyncLocalStorage<LlmTally>();

/** Runs `fn`; every counted call inside it, at any depth, adds to the tally. */
export function tallied<T>(fn: () => Promise<T>): { tally: LlmTally; done: Promise<T> } {
  const tally: LlmTally = { calls: 0, inputTokens: 0, outputTokens: 0 };
  return { tally, done: tallies.run(tally, fn) };
}

/** The call itself is untouched; a failed one is counted with no tokens and rethrown. */
export function countedLlm(llm: Llm, calls: LlmCalls, now: () => number = Date.now): Llm {
  return {
    id: llm.id,
    async complete(req: LlmRequest): Promise<LlmReply> {
      const t0 = now();
      const row = (ok: boolean, r: LlmReply | null): LlmCall => ({
        at: new Date(t0).toISOString(),
        model: llm.id,
        purpose: req.purpose ?? "unlabeled",
        inputTokens: r?.usage.inputTokens ?? 0,
        cachedTokens: r?.usage.cachedTokens ?? 0,
        outputTokens: r?.usage.outputTokens ?? 0,
        ms: now() - t0,
        ok,
        images: req.images?.length ?? 0,
        promptChars: req.system.length + req.prompt.length,
      });
      const count = (c: LlmCall): void => {
        calls.record(c);
        const t = tallies.getStore();
        if (!t) return;
        t.calls++;
        t.inputTokens += c.inputTokens;
        t.outputTokens += c.outputTokens;
      };
      try {
        const r = await llm.complete(req);
        count(row(true, r));
        return r;
      } catch (err) {
        count(row(false, null));
        throw err;
      }
    },
  };
}

export interface LlmUse {
  n: number;
  failed: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

export interface LlmCallReport extends LlmUse {
  byPurpose: (LlmUse & { purpose: string })[];
  byModel: (LlmUse & { model: string })[];
  /** UTC days, oldest first. */
  byDay: (LlmUse & { day: string })[];
}

function usageOf(cs: readonly LlmCall[]): LlmUse {
  const u: LlmUse = { n: 0, failed: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
  for (const c of cs) {
    u.n++;
    if (!c.ok) u.failed++;
    u.inputTokens += c.inputTokens;
    u.cachedTokens += c.cachedTokens;
    u.outputTokens += c.outputTokens;
  }
  return u;
}

function usageBy<K extends string>(cs: readonly LlmCall[], name: K, key: (c: LlmCall) => string) {
  const m = new Map<string, LlmCall[]>();
  for (const c of cs) m.set(key(c), [...(m.get(key(c)) ?? []), c]);
  return [...m].map(
    ([k, group]) => ({ [name]: k, ...usageOf(group) }) as LlmUse & Record<K, string>,
  );
}

/** Calls and tokens in all, by purpose and model (most input first), and by day. */
export function llmCallReport(calls: readonly LlmCall[]): LlmCallReport {
  const most = (a: LlmUse, b: LlmUse) => b.inputTokens - a.inputTokens;
  return {
    ...usageOf(calls),
    byPurpose: usageBy(calls, "purpose", (c) => c.purpose).sort(most),
    byModel: usageBy(calls, "model", (c) => c.model).sort(most),
    byDay: usageBy(calls, "day", (c) => c.at.slice(0, 10)).sort((a, b) =>
      a.day.localeCompare(b.day),
    ),
  };
}
