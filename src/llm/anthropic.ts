/** Anthropic Messages API over the shared http client; the key lives in a header only. */
import type { HttpClient } from "../clients/http.js";
import type { Llm, LlmReply, LlmRequest, LlmUsage } from "./types.js";

const URL = "https://api.anthropic.com/v1/messages";

interface MessagesResponse {
  model: string;
  content: Array<{ type: string; text?: string }>;
  usage: AnthropicUsage;
}

/** Anthropic's usage: input is the uncached part; cache writes and reads are counted beside it. */
export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Every input token, cached or not; the cache reads apart. */
export const usageOf = (u: AnthropicUsage | undefined): LlmUsage => ({
  inputTokens:
    (u?.input_tokens ?? 0) +
    (u?.cache_creation_input_tokens ?? 0) +
    (u?.cache_read_input_tokens ?? 0),
  outputTokens: u?.output_tokens ?? 0,
  cachedTokens: u?.cache_read_input_tokens ?? 0,
});

export function anthropicLlm(opts: { apiKey: string; model: string; http: HttpClient }): Llm {
  return {
    id: `anthropic/${opts.model}`,
    async complete(req: LlmRequest): Promise<LlmReply> {
      const r = await opts.http.json<MessagesResponse>(URL, {
        method: "POST",
        headers: { "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
        body: {
          model: opts.model,
          max_tokens: req.maxTokens ?? 2048,
          system: req.json
            ? `${req.system}\nReply with one JSON object and nothing else.`
            : req.system,
          messages: [
            {
              role: "user",
              content: req.images?.length
                ? [
                    ...req.images.map((i) => ({
                      type: "image",
                      source: { type: "base64", media_type: i.mediaType, data: i.data },
                    })),
                    { type: "text", text: req.prompt },
                  ]
                : req.prompt,
            },
          ],
        },
      });
      if (!r.ok || !r.body) throw new Error(`anthropic: HTTP ${r.status}`);
      return {
        text: r.body.content.map((c) => c.text ?? "").join(""),
        usage: usageOf(r.body.usage),
        model: r.body.model,
      };
    },
  };
}
