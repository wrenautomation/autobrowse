/**
 * Cohere's own v2/chat, not its OpenAI-compatible door: a thinking model
 * (command-a-plus) returns its reasoning and its answer as separate content
 * parts here, while the compat endpoint merges them into one `content` that
 * runs out of tokens mid-thought. We read the `text` parts only, and cap the
 * thinking so a long prompt cannot spend the whole budget before the answer
 * starts (uncapped, a 20k budget went entirely to thinking on a 200-line
 * module). Only the models that think are sent the cap.
 */
import type { HttpClient } from "../clients/http.js";
import type { Llm, LlmReply, LlmRequest } from "./types.js";

interface ChatResponse {
  /** The reply on a 2xx; on a 4xx Cohere puts its reason here as a plain string. */
  message?: { content?: Array<{ type: string; text?: string; thinking?: string }> } | string;
  finish_reason?: string;
  usage?: { tokens?: { input_tokens?: number; output_tokens?: number } };
  error?: string;
}

/** command-a-plus-05-2026, command-a-reasoning-08-2025: the ones that return a `thinking` part. */
const THINKS = /-(plus|reasoning)-/;
const THINKING_BUDGET = 2_000;

export function cohereLlm(opts: {
  apiKey: string;
  model: string;
  http: HttpClient;
  baseUrl?: string;
  /** Tokens the model may spend thinking before it must answer; 0 for none. */
  thinkingBudget?: number;
}): Llm {
  const wanted = opts.thinkingBudget ?? THINKING_BUDGET;
  /** Cohere refuses a budget above max_tokens, and a caller who asks for few tokens wants an answer, not thought. */
  const thinkingFor = (maxTokens: number) =>
    THINKS.test(opts.model) && wanted > 0
      ? { thinking: { type: "enabled", token_budget: Math.min(wanted, Math.floor(maxTokens / 2)) } }
      : {};
  const url = `${(opts.baseUrl ?? "https://api.cohere.com").replace(/\/$/, "")}/v2/chat`;
  return {
    id: `cohere/${opts.model}`,
    async complete(req: LlmRequest): Promise<LlmReply> {
      const maxTokens = req.maxTokens ?? 2048;
      const r = await opts.http.json<ChatResponse>(url, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}` },
        body: {
          model: opts.model,
          max_tokens: maxTokens,
          ...thinkingFor(maxTokens),
          ...(req.json ? { response_format: { type: "json_object" } } : {}),
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.prompt },
          ],
        },
      });
      if (!r.ok || !r.body) {
        const said = r.body?.message;
        const why = (typeof said === "string" ? said : (r.body?.error ?? "")).slice(0, 300);
        throw new Error(`cohere: HTTP ${r.status}${why ? ` ${why}` : ""}`);
      }
      const said = r.body.message;
      const parts = typeof said === "string" ? [] : (said?.content ?? []);
      const text = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("");
      if (!text && r.body.finish_reason === "MAX_TOKENS")
        throw new Error(
          `${opts.model}: all ${req.maxTokens} tokens went to thinking; raise maxTokens`,
        );
      return {
        text,
        usage: {
          inputTokens: r.body.usage?.tokens?.input_tokens ?? 0,
          outputTokens: r.body.usage?.tokens?.output_tokens ?? 0,
        },
        model: opts.model,
      };
    },
  };
}
