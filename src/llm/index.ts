/** `makeLlm(settings)`: the one place a provider is chosen. Null when no key is set; callers degrade. */
import type { HttpClient } from "../clients/http.js";
import { anthropicLlm } from "./anthropic.js";
import { claudeCodeLlm } from "./claude-code.js";
import { cohereLlm } from "./cohere.js";
import { openaiLlm } from "./openai.js";
import type { Llm } from "./types.js";

export type LlmProvider = "anthropic" | "openai" | "cohere" | "claude-code";

export interface LlmSettings {
  provider: LlmProvider;
  model: string | undefined;
  anthropicApiKey: string | undefined;
  openaiApiKey: string | undefined;
  openaiBaseUrl: string | undefined;
  cohereApiKey: string | undefined;
}

export const DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5",
  /** Cohere's own door, so a thinking model's answer is not merged into its reasoning. */
  cohere: "command-a-plus-05-2026",
  /** Headless Claude Code on the person's subscription: no key needed. */
  "claude-code": "sonnet",
};

export function makeLlm(s: LlmSettings, http: HttpClient): Llm | null {
  const model = s.model ?? DEFAULT_MODELS[s.provider];
  if (s.provider === "claude-code") return claudeCodeLlm({ model });
  if (s.provider === "anthropic")
    return s.anthropicApiKey ? anthropicLlm({ apiKey: s.anthropicApiKey, model, http }) : null;
  if (s.provider === "cohere") {
    const apiKey = s.cohereApiKey ?? s.openaiApiKey;
    return apiKey ? cohereLlm({ apiKey, model, http }) : null;
  }
  return s.openaiApiKey
    ? openaiLlm({
        apiKey: s.openaiApiKey,
        model,
        http,
        ...(s.openaiBaseUrl ? { baseUrl: s.openaiBaseUrl } : {}),
      })
    : null;
}

export {
  BudgetExceeded,
  type BudgetedLlm,
  budgetedLlm,
  type DayLedger,
  dayOf,
  fileLedger,
  type Ledger,
  memoryLedger,
} from "./budget.js";
export { fakeLlm } from "./fake.js";
export {
  completeJson,
  extractJson,
  type Llm,
  LlmOutputInvalid,
  type LlmReply,
  type LlmRequest,
  type LlmUsage,
} from "./types.js";
