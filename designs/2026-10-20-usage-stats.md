# Usage stats on by default

2026-10-20. Ask from the application-system session (a library consumer) and William.

## Goal

Every caller gets token use and failure rates with no setup, from library code and the CLI the same way.

## Target state

- `makeLlm` counts every call into `~/.config/autobrowse/llm` (the model call ledger).
- `flowRunner` writes one row per run, success or not, into `~/.config/autobrowse/flows`.
  A row holds outcome, duration, acts, the failing step's goal, captcha tries, and the tokens of counted calls made inside the run.
- `autobrowse tokens` and `autobrowse success` read both. Library callers read them with `readLlmCalls` + `llmCallReport` and `readFlowRuns` + `flowRunReport`.
- To turn off in code: `makeLlm(..., { calls: null })` and `flowRunner(opts, { runs: null })`. To turn off for all: `AUTOBROWSE_STATS=off`. To move: `AUTOBROWSE_STATS_DIR`.

## Decision log

- 10-20: Default on, not opt-in. William: "by default ... as easy to enable by default". Rows hold no input, prompt or page text, so on by default is safe.
- 10-20: Per-run tokens come from an `AsyncLocalStorage` tally inside `countedLlm`, not from a wrapper on `Eyes`. Any counted model used in the run (eyes, repairs) adds to it, with no new parameter.
- 10-20: One knob per part (`calls`, `runs`), each with a code parameter and the env switch. William: "should be code parameter to disable it imo, but env var is fine".
- 10-20: `boot()` sets `AUTOBROWSE_STATS_DIR` to the owner's state dir, so CLI and desk rows land where that owner's reports read.
- 10-20: Tests run with `AUTOBROWSE_STATS=off` (vitest env), so no test writes to the home folder.
- 10-20: Not done: a run that fails while the browser opens (before the flow starts) writes no row. Its error goes to the caller as before.
