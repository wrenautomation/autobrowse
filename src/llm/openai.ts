/** OpenAI Chat Completions over the shared http client. Any OpenAI-compatible base URL works. */
import type { HttpClient } from "../clients/http.js";
import type { Llm, LlmReply, LlmRequest } from "./types.js";

interface ChatResponse {
  model: string;
  choices: Array<{ message: { content: string | null } }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
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
      if (!r.ok || !r.body) throw new Error(`openai: HTTP ${r.status}`);
      return {
        text: r.body.choices[0]?.message.content ?? "",
        usage: {
          inputTokens: r.body.usage?.prompt_tokens ?? 0,
          outputTokens: r.body.usage?.completion_tokens ?? 0,
        },
        model: r.body.model,
      };
    },
  };
}
