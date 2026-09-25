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

/** A provider's 400 naming its output cap: "max tokens must be less than or equal to 8192". */
const OUTPUT_CAP = /(?:less than or equal to|at most|maximum (?:value )?(?:is|of))\s*(\d{3,7})/i;

export function openaiLlm(opts: {
  apiKey: string;
  model: string;
  http: HttpClient;
  baseUrl?: string;
}): Llm {
  const url = `${(opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`;
  /** The model's output cap, learned from the first 400 that names it; asks above it are clamped. */
  let cap = Number.POSITIVE_INFINITY;
  const post = (req: LlmRequest) =>
    opts.http.json<ChatResponse>(url, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.apiKey}` },
      body: {
        model: opts.model,
        max_tokens: Math.min(req.maxTokens ?? 2048, cap),
        ...(req.json ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.prompt },
        ],
      },
    });
  const reason = (r: { body: ChatResponse | null }) =>
    (r.body?.error?.message ?? r.body?.message ?? "").slice(0, 200);
  return {
    id: `openai/${opts.model}`,
    async complete(req: LlmRequest): Promise<LlmReply> {
      let r = await post(req);
      const capped = r.status === 400 ? OUTPUT_CAP.exec(reason(r)) : null;
      if (capped && Number(capped[1]) < (req.maxTokens ?? 2048)) {
        cap = Number(capped[1]);
        r = await post(req);
      }
      if (!r.ok || !r.body) {
        const why = reason(r);
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
