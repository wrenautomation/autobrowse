# Runs, walks from runs, token ledger

2026-09-30. Status: built.

## Ask

William: make agent tracking and explore audit logs robust, so history
builds up and deterministic workflows come out of successful runs (the
Google and Microsoft sign-on setups a parallel session did by hand in
explore). Log tokens for everything autobrowse spends, judge the
efficiency, and report it: fix it if bad, note it if good.

## What was there

- Explore journal: the acts, for resume. `close` deleted it. No looks.
- Recordings: only when someone sent `save`.
- Step ledger (`steps.jsonl`): one row per agent step with tokens. The
  `claude-code` driver logged 2 input tokens a step (cache reads unseen).
- OTLP spans and a daily token total. No per-call ledger with a purpose;
  no record of what an explore answer cost the caller.

## Shape

### Runs

A run is one explore session from `goal` to `done`, across crashes and
resumes: `runs/<site>/<run>.jsonl` beside the credentials file (per owner,
outside git, 0600), hash-chained like the other ledgers.

| Row | Carries |
|---|---|
| `start` | driver (`console`, `agent:<model>`, `person`), goal, machine, viewport |
| `goal` | the goal, set or changed |
| `cmd` | every command: name, ok, ms, answer chars and tokens, the whole-page size for acts and looks |
| `act` | each journaled act (secrets by name) with the page look before it; `hand` when a person did it |
| `end` | `achieved`, `failed`, `saved`, `closed` or `idle`; a summary; the last look |

`runs/index.jsonl` has one line per ended run. A file with no `end` died
(`openRuns`). `close` drops the journal, never the run. A `goal` after a
`done` starts the next run in the same session.

CLI: `explored [site]`, `explored show <run>` (shape only, never values).
`runs` stays the workflow registry.

### Walks

`walks build <site> <name> (--goal-like <words> | --run a,b)` turns ended
runs (`achieved` or `saved`) into `walks/<site>/<name>.json`:

1. A run's acts split into visits: a new visit when the look is not the
   same page (same URL shape, landmarks at least half shared).
2. Visits across runs cluster into screens. Repeat visits to one page in a
   run are separate screens, ordered by `after`.
3. A screen is known by its URL and up to four landmarks every visit
   showed, the ones that tell it from same-URL screens first.
4. Its ops come from the newest run. Where runs differ, the newest wins
   and the build says so.
5. A fill with the same text in every run is a literal; text that differed
   is a plan field; a placed secret stays a secret by name.
6. The goal screen is the end look's common landmarks.
7. Pause..resume becomes a `human` op; a solved captcha a `captcha` op;
   a person's navigation is skipped.

A walk runs through `walk()` (designs/2026-09-27-screens.md): look, take
the first screen the page is, act, wait for the page to change. A page no
screen knows goes down the ladder: learned screens, the reader, a person.
An op can be `{"kind":"walk","walk":"<site>/<name>"}`: walks nest (a
sign-in inside a setup), four deep at most.

Every walk is a flow, `<site>/walk-<name>`. The CLI (`walks run`) and the
Restate `browser/flow` handler run it the same way; the handler reads the
file per call, so a rebuilt walk runs at once.

Secrets resolve through the owner's stored logins (`loginSecrets`): a bare
`password` is the walk's own site's; `google.password` names another. Codes
come from the site's inbox. Card and wallet fields go to a person.

### Tokens

- `llm/llm-YYYY-MM.jsonl`: every model call with purpose (`agent-step`,
  `repair`, `screen-read`, `captcha`, `compile-polish`, `compile-finish`,
  `evaluate`, `do-pick`), model, input, cached, output, ms, ok.
- Run `cmd` rows: what each explore answer cost the caller.
- `tokens [--days n] [--json]`: per purpose and model, per explore command
  against whole-page answers, and the verdict.

Baselines, input tokens per model call (stagehand.dev/blog/playwright-mcp-token-usage):

| Tool | Per call | Per task |
|---|---|---|
| Playwright MCP (accessibility snapshot every act) | 12.9k–14.1k | 97k median |
| Stagehand v4 | 6.9k | 32k median |

Verdict per call: a third of the best baseline or less (≤ 2.3k) is good;
up to it is standard; above it is bad.

**Reading, 2026-09-30:** 52 counted agent steps (steps.jsonl, 09-22 →
09-30, `command-a`): median 1,432 input tokens a step, p90 1,587, about
170 out. Flat across a session: the prompt carries the page digest and the
last six steps, never old pages. **Good**: about a ninth of Playwright MCP
and a fifth of Stagehand per call. Kept as is; worth quoting.

## Decision log

1. Runs are their own chained files, not the journal. The journal is
   resume state and small; history is forever.
2. Per owner, outside git. Acts hold the owner's values and URLs.
3. Answer size is estimated (chars / 4), the same way the baselines were
   measured. Real spend comes from provider usage in the call ledger.
4. Purpose rides on the request, not ambient state. A call without one is
   `unlabeled` and shows in the report.
5. Walks are data run by one interpreter, not rendered TypeScript: rebuilt
   from new runs with no compile, and `walk()` already has the ladder.
6. Runs disagree: the newest wins. Older ops were right for an older page.
7. A walk is marked irreversible when any click matches the irreversible
   words or the payment gate; `walks run` wants `--yes`, and the payment
   gate still holds every spend.
8. `explored`, not `runs`: `runs` was already the workflow registry.

## Where to attack

1. ✅ Runs: `goal`/`done`, the chained run file, looks before acts, `close` keeps history.
2. ✅ Call ledger with purposes, the claude-code usage fix, `tokens`.
3. ✅ Walk builder, runner, catalog fallback (`<site>/walk-<name>`).
4. Ship runs to S3 per owner (the shots bucket pattern), so a box's
   history survives the box.
5. Build the Google and Microsoft SSO walks from the parallel session's
   runs once they end with `done`.
6. Render a walk to TypeScript once it has run clean N times.
