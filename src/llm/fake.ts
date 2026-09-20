/** Scripted model for tests: replies in order, records every request. */
import type { Llm, LlmReply, LlmRequest } from "./types.js";

export interface FakeLlm extends Llm {
  requests: LlmRequest[];
}

export function fakeLlm(
  replies: Array<string | object>,
  usage = { inputTokens: 10, outputTokens: 5 },
): FakeLlm {
  const queue = [...replies];
  const requests: LlmRequest[] = [];
  return {
    id: "fake",
    requests,
    async complete(req): Promise<LlmReply> {
      requests.push(req);
      const next = queue.shift();
      if (next === undefined) throw new Error("fakeLlm: no reply scripted for this call");
      const text = typeof next === "string" ? next : JSON.stringify(next);
      return { text, usage: { ...usage }, model: "fake" };
    },
  };
}
