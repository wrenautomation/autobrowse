/**
 * Every model call, one line: what it was for, which model, the tokens and
 * the time. `countedLlm` wraps any `Llm`; the rows go to one file per month
 * (`llm-2026-09.jsonl`), so the log stays bounded and a report reads only
 * the months it covers. Plain appends, not a chain: several processes write
 * here at once and a line under 4 KB lands whole. Never a prompt or a reply.
 */
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
      try {
        const r = await llm.complete(req);
        calls.record(row(true, r));
        return r;
      } catch (err) {
        calls.record(row(false, null));
        throw err;
      }
    },
  };
}
