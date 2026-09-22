/** OpenAI Chat Completions over the shared http client. Any OpenAI-compatible base URL works. */
import type { HttpClient } from "../clients/http.js";
import type { Llm, LlmReply, LlmRequest } from "./types.js";

interface ChatResponse {
  model: string;
  /**
   * A reasoning model (command-a-plus, o-series) spends completion tokens on
   * `reasoning_content` first; when the budget runs out there, `content` comes
   * back empty with finish_reason "length".
   */
  choices: Array<{
    message: { content: string | null; reasoning_content?: string | null };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
  /** The provider's reason on a 4xx (a model name, a token limit); never a secret. */
  error?: { message?: string };
  message?: string;
}

export function openaiLlm(opts: {
  apiKey: string;
  model: string;
  http: HttpClient;
  baseUrl?: string;
}): Llm {
  const url = `${(opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`;
  return {
    id: `openai/${opts.model}`,
    async complete(req: LlmRequest): Promise<LlmReply> {
      const r = await opts.http.json<ChatResponse>(url, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}` },
        body: {
          model: opts.model,
          max_tokens: req.maxTokens ?? 2048,
          ...(req.json ? { response_format: { type: "json_object" } } : {}),
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.prompt },
          ],
        },
      });
      if (!r.ok || !r.body) {
        const why = (r.body?.error?.message ?? r.body?.message ?? "").slice(0, 200);
        throw new Error(`openai: HTTP ${r.status}${why ? ` ${why}` : ""}`);
      }
      const choice = r.body.choices[0];
      if (!choice?.message.content && choice?.finish_reason === "length") {
        throw new Error(
          `${opts.model}: reply hit the token limit before any content${
            choice.message.reasoning_content ? " (all of it went to reasoning)" : ""
          }; raise maxTokens`,
        );
      }
      return {
        text: choice?.message.content ?? "",
        usage: {
          inputTokens: r.body.usage?.prompt_tokens ?? 0,
          outputTokens: r.body.usage?.completion_tokens ?? 0,
        },
        model: r.body.model,
      };
    },
  };
}
