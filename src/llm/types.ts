/**
 * One narrow seam for every model call: a prompt in, text out, usage
 * counted. Callers that need structure go through `completeJson`, which
 * validates with zod and asks once more with the validation error before
 * giving up. The LLM proposes; the code around it disposes.
 */
import type { z } from "zod";

export interface LlmRequest {
  system: string;
  prompt: string;
  /** Ask the provider for a JSON object; the reply is still validated. */
  json?: boolean;
  maxTokens?: number;
  /** Pictures the model looks at before the prompt (a captcha). A driver that cannot see throws. */
  images?: LlmImage[];
  /** What the call is for (`agent-step`, `repair`): the token ledger groups by it. Drivers ignore it. */
  purpose?: string;
}

export interface LlmImage {
  mediaType: "image/png" | "image/jpeg";
  /** Base64, no data: prefix. */
  data: string;
}

export interface LlmUsage {
  /** Every input token, cache reads and writes included. */
  inputTokens: number;
  outputTokens: number;
  /** Of the input, how many were read from the provider's prompt cache (billed far lower). */
  cachedTokens?: number;
}

export interface LlmReply {
  text: string;
  usage: LlmUsage;
  model: string;
}

export interface Llm {
  /** Provider and model, for logs and the run ledger. */
  readonly id: string;
  complete(req: LlmRequest): Promise<LlmReply>;
}

export class LlmOutputInvalid extends Error {
  constructor(
    readonly issues: string,
    readonly text: string,
  ) {
    super(`model output did not match the schema: ${issues}`);
    this.name = "LlmOutputInvalid";
  }
}

/** Strip a ```json fence if the model added one, then parse. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) throw new SyntaxError("no JSON object in reply");
  return JSON.parse(body.slice(start, end + 1));
}

export async function completeJson<T>(
  llm: Llm,
  schema: z.ZodType<T>,
  req: LlmRequest,
  retries = 1,
): Promise<{ value: T; usage: LlmUsage }> {
  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  let prompt = req.prompt;
  let last: LlmOutputInvalid | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const reply = await llm.complete({ ...req, prompt, json: true });
    usage.inputTokens += reply.usage.inputTokens;
    usage.outputTokens += reply.usage.outputTokens;
    let parsed: unknown;
    try {
      parsed = extractJson(reply.text);
    } catch (err) {
      last = new LlmOutputInvalid(err instanceof Error ? err.message : String(err), reply.text);
      prompt = `${req.prompt}\n\nYour previous reply was not valid JSON (${last.issues}). Reply with one JSON object only.`;
      continue;
    }
    const result = schema.safeParse(parsed);
    if (result.success) return { value: result.data, usage };
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "$"}: ${i.message}`)
      .join("; ");
    last = new LlmOutputInvalid(issues, reply.text);
    prompt = `${req.prompt}\n\nYour previous reply failed validation: ${issues}. Fix those fields and reply with the JSON object only.`;
  }
  throw last ?? new Error("unreachable");
}
