---
type: object
cluster: runs
universe: live
status: verified
verified: 2026-10-20 @ HEAD
entity: src/runs/flows.ts
---

# Flow run ledger

One JSON line per `flowRunner` run, success or not: `FlowRunRow` in `src/runs/flows.ts`, monthly files `flows/flows-YYYY-MM.jsonl` in the stats dir. On by default (design `designs/2026-10-20-usage-stats.md`).

## Why this shape

A failure record says why one run broke; failure rates need every run. No input or page text, only the goal and the error's text (300 chars).

## Shape

- `FlowRunRow { site, flow, startedAt, endedAt, ms, outcome, submitted, goal, error, acts, captchaTries, captchaSolved, llmCalls, inputTokens, outputTokens }` — `src/runs/flows.ts:13`; `fileFlowRuns` — `:42`; `readFlowRuns` — `:66`; `flowRunReport` — `:138`; `formatFlowRunReport` — `:170`
- Default place: `statsDir` — `src/deps/stats.ts`; `RunnerOptions.runs` — `src/browser/flow.ts:335`, default at `:471`; `runRow` — `:351`; the row at `:1080`
- A browser that never opens still writes a row: goal `open the browser`, acts 0, outcome interrupted (transient) or failed — `src/browser/flow.ts:526`
- Tokens per run: `tallied` — `src/llm/ledger.ts:85`, run at `src/browser/flow.ts:991`
- CLI: `autobrowse success` reads `flowRunsDirFor` — `src/app/services-state.ts:352`

## Connected to

- **joins:** [[llm-call]] (tokens per run), [[site-call-ledger]] (`autobrowse success`)
- **looks-like-but-is-not:** the failure record (`*.failure.json`, one broken run); [[watch-step]] (per step)

## If you change this

- **Hits:** `src/browser/flow.ts`, `src/app/cli-runs.ts`, library callers that read rows.
