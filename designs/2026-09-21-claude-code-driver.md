# Claude Code as a first-class driver

William, 2026-09-21: everything usable through the agent; Claude Code should be
able to power the specific steps, talking to the web through autobrowse with
smarter page processing to keep tokens down; a first-class option beside the API.

## Decision

Two shapes, both kept. Shape A is built; shape B is next.

**A. Claude Code as the model** (`LLM_PROVIDER=claude-code`, built 2026-09-21).
`src/llm/claude-code.ts` runs `claude -p --output-format json --tools "" --no-session-persistence`
per call behind the same `Llm` seam the API drivers use. No key; the person's
subscription pays. Every model call in autobrowse (explorer steps, compile
polish, locator repair, evaluator, reply classification) goes through it
unchanged. Cost: ~2 s process start per call; fine for chores, wrong for a
hot loop. `LLM_MODEL` picks the model alias (`sonnet`, `opus`, `haiku`).

**B. autobrowse as Claude Code's tools** (next). An MCP server (`autobrowse mcp`)
that exposes the explore loopback as tools: `open`, `aria` (digested refs, not
raw trees), `click`, `fill`, `read`, `text`, `eval`, `screenshot`, `pause`,
`resume`, `save`, plus `run <workflow>` and `compile`. Claude Code then owns
the loop and its own reasoning; autobrowse owns the browser, the journal, the
guards, credentials and compilation. The person can drive the same session
from Claude Code, the UI, or curl, and every act still lands in the journal,
so the outcome is still a recording that compiles to a deterministic flow.
Terminal steps are Claude Code's own tools; the recorder journals them the
same way `record --terminal` does today.

## Why not only B

B makes the loop Claude Code's; A keeps autobrowse's loop (bounded steps,
digest diffing, budget ledger, unattended builder) and only swaps the brain.
Unattended runs on the box need A (no interactive session there). A person
at a keyboard with a hard goal wants B.

## Token discipline (applies to both)

- The digest (`src/agent/digest.ts`) is the page the model sees: controls as
  `[n] role "name"`, headings, trimmed text, and only the diff when the page
  did not change. Raw aria never reaches the model.
- Secrets never reach it either: `redactAria` masks filled secret fields.
- Next reducers, in order: `extract` (main-content only, readability-style)
  for reading pages; `eval` results capped; screenshots only on request.

## Open

- B's MCP transport: stdio (Claude Code spawns `autobrowse mcp`) for the
  laptop; the box has no interactive Claude Code, so B is laptop-only.
- Whether B should reuse the agent's step schema as tool schemas (yes: one
  vocabulary, two callers).
