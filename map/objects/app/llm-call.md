---
type: object
cluster: app
universe: live
status: verified
verified: 2026-09-30 @ runs-and-walks
entity: src/llm/ledger.ts
---

# Model call ledger

Every model call autobrowse makes, one JSON line each with its purpose: `LlmCall` in `src/llm/ledger.ts`, monthly files `llm/llm-YYYY-MM.jsonl` beside the credentials file. `autobrowse tokens` reads it with the run `cmd` rows and gives the verdict.

## Why this shape

Spend has to be read back by purpose to judge it. Purpose rides on the request (`LlmRequest.purpose`), so a call without one shows as `unlabeled`, never hidden.

## Shape

- `LlmCall { at, model, purpose, inputTokens, cachedTokens, outputTokens, ms, ok, images, promptChars }` — `src/llm/ledger.ts:12`; `fileLlmCalls`, `memoryLlmCalls`, `readLlmCalls` — `:33-54`
- `countedLlm` wraps the app's model so every call is counted — `:75`; wired in `src/app/services.ts:371`
- Report: `tokenReport` — `src/runs/tokens.ts:101`; `BASELINES` (Playwright MCP 13.5k, Stagehand 6.9k a call) and `GOOD_PER_CALL` 2.3k — `:20-22`; `readCmds` — `:85`

## Connected to

- **owned-by:** the app's model ([[app]])
- **joins:** [[explore-run]] (answer tokens), [[agent-session]] (`steps.jsonl`, read when no call rows exist)
- **looks-like-but-is-not:** the OTLP trace sink (spans to Langfuse); the step ledger

## If you change this

- **Hits:** `src/runs/tokens.ts`, every caller that sets `purpose` (`src/agent/explorer.ts`, `src/browser/repair.ts`, `src/browser/screens.ts`, `src/browser/captcha/llm-eyes.ts`, `src/compiler/polish.ts`, `src/compiler/finish.ts`, `src/agent/evaluator.ts`, `src/do/pick.ts`).
- **Does not hit:** the providers themselves.

## Surfaces

| Surface | Role |
|---|---|
| every model call | writes |
| `autobrowse tokens` | reads |

## See

- Source: `src/llm/ledger.ts`, `src/runs/tokens.ts`
