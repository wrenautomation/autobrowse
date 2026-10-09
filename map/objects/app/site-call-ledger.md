---
type: object
cluster: app
universe: live
status: verified
verified: 2026-10-09 @ eca4223
entity: src/runs/calls.ts
---

# Site call ledger

Every try at a `sites`/`desk` call, one JSON line each, kept for good: `SiteCallRow` in `src/runs/calls.ts`, monthly files `calls/calls-YYYY-MM.jsonl` beside the credentials file. `autobrowse success` reads it with explore runs, agent steps and model calls.

## Why this shape

Restate keeps a finished invocation about a day and `caps` only metered reads for 14 days; success rates need the whole history. A failure is any try that does not reach the end state: it is counted, never aborts anything. Route and error text only, never input or answer.

## Shape

- `SiteCallRow { at, service, site, route, caller, invocation, attempt, ok, status, terminal, error, ms, from? }` — `src/runs/calls.ts:13-33`; `fileSiteCalls` (plain appends, error cut to 300 chars) — `:42`; `readSiteCalls` — `:64`; `settledCalls` (one line per invocation, its last try) — `:85`
- Written inside `ctx.run` on every try, retries included — `src/sites/service.ts:80-122,153`; dir `siteCallsDirFor` — `src/app/services.ts:608`; wired for `sites` (`:1556`) and `desk` (`src/app/desk.ts:41`)
- Report: `successReport` — `src/runs/success.ts:152`; failure kinds `cmdFailure` (`:35`), `callFailure` (`:50`); `STRUGGLE` 3 failed commands a run — `:65`
- Backfill: `fromRestate`, `fromCaps`, `newRows` (never a row the ledger has) — `src/runs/import.ts:31,60,83`

## Connected to

- **owned-by:** [[site-call]] (`sitesService` writes it)
- **joins:** [[explore-run]] (verdicts and failed commands), [[llm-call]] (failed model calls), [[agent-session]] (failed steps)
- **looks-like-but-is-not:** the `caps` ledger (metered reads only, pruned at 14 days); Restate's invocation table

## If you change this

- **Hits:** `src/runs/success.ts`, `src/runs/import.ts`, `src/app/cli-runs.ts` (`success`, `success import`).
- **Does not hit:** the facade, caps, pacing.

## Surfaces

| Surface | Role |
|---|---|
| Restate `sites`, `desk` | write |
| `autobrowse success`, `success import` | read, backfill |

## See

- Source: `src/runs/calls.ts`, `src/runs/success.ts`
- Design: `designs/2026-10-09-success-tracking.md`
