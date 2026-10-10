# Success tracking (2026-10-09)

A failure is any try that did not reach the end state. It is counted, never
aborted on. Example: three failed explore commands in one run. Repeat
misses point at the page digest.

## What is recorded

- **Explore runs** (`runs/`, since 10-01): a verdict per run and an error per
  command. Nothing new is written. `stop.sh <port> achieved|failed "…"` now
  sends `done` before `close`, so fewer runs end with no verdict.
- **Site calls** (`calls/calls-YYYY-MM.jsonl`, new, kept for good): every try
  of a `sites`/`desk` call. Fields: route, caller, invocation, attempt, ok,
  status, terminal, error, ms. Written inside `ctx.run`, so a replay writes
  nothing. Never the input or the answer.
- Agent steps (`steps.jsonl`) and model calls (`llm/`): read as they are.

## Report

`autobrowse success [--days n] [--site x] [--json]`:

- Explore runs: reached, failed and no verdict. Failed commands by kind:
  target-miss, wait-timeout, sign-in, gate, cap, unknown-site, other.
- Target-miss rate over acts (click, fill, select, upload…): the digest's
  health number.
- Runs with 3+ failed commands.
- Site calls settled per invocation, by failure kind and by route shape.

## Decisions

- **One ledger per source, not a shared event table.** Each writer already
  has its own file. The report joins them.
- **Monthly files, no pruning.** The caps ledger drops calls after 14 days
  and Restate keeps a day. History is the point here.
- **Backfill once.** `success import` copies Restate's finished calls (route
  read off the journal step name) and the caps ledger. It skips invocations
  already there.
- **CLI only.** No UI, no alerts yet.

## First numbers (30 days to 10-09)

- Explore: 131 runs. 90% of runs with a verdict reached it. 60 had no verdict.
- Target misses: 19% of acts. `select` fails 64%, `fill` 29%, `click` 18%.
  This is where the digest work goes.
- Site calls: 21% failed. Most were the reddit-public `limit=200` bug, fixed in
  wren 46d2d16d. Next: meta `/instagram/{username}` 29% and fb-public group
  posts 51%.
- 2026-10-09: a failed act's row keeps its target in a few words and why the locator missed,
  read off Playwright's call log: `not-found` (nothing matched: the digest's fault) or found but
  `hidden`, `covered`, `disabled`, `detached` (the hands' or the page's). The first report could
  not say which: 184 timeouts, no targets. `select`'s 65% was one Discord session on code a day
  old (the 0x0 combobox fix, cb8f7e1); since then 3 of 4.
- 2026-10-10: a call refused at a cap is shown apart (`capped`) and routes rank by failures that
  are not caps. Of the first report's worst routes, `meta GET /instagram/{username}` was 120 asks
  past the cap in one 10-06 enrichment run (3 real failures of 307), `linkedin GET /messaging`
  the reach poller asking past the 48 a day inbox cap. `fb-public` group posts failed 48 of 93 in
  one signed-out burst on 10-06 (backfilled, no error text); the walk is unchanged and reads 3 of
  3 today.
