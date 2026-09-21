# 6 · The agent, `do`, healing

**Goal:** one verb. Say what you want; autobrowse routes it to the thing
that does it, or builds that thing once.

## `do`

```sh
pnpm autobrowse do "list my youtube videos" --dry-run     # what would run, running nothing
pnpm autobrowse do "upload this to youtube" --input file=talk.mp4 --input title="Talk"
pnpm autobrowse do "rename my google account" --input name=Wren --site google
pnpm autobrowse abilities                                # what it can pick from, what is not recorded
```

Routing order: a site route under its API shape → a compiled workflow → a
hand-written flow → a command-line tool (`wrangler-deploy`, `gh-pr-create`,
`ffmpeg-convert`; ready when the binary is on the PATH). Picks are kept
(`recordings/.do-picks.json`) so the same ask in other words lands the same
way. Nothing ready → the agent explores the site once, saves, compiles;
the second same ask is deterministic. Gates hold inside every leg.

Same verb: `POST /api/do` (a job; `dryRun` answers at once), Restate `do/run`
for wren (`restateDo`), the `do` tool of `autobrowse mcp`.

## The agent

```sh
pnpm autobrowse agent google "open Personal info and report the display name" --save google-name
pnpm autobrowse agent anthropic "make an API key named wren and keep it as ANTHROPIC_API_KEY" --headed
```

Each step the model sees the URL and a digest of the page (`[n]B Save`
refs, ~1k chars), picks one act, the code runs and journals it. `done` or
`human` ends it. `human` is a pause with a prompt: do the captcha or the
purchase in the window, resume, it goes on. `--max-steps` (25) caps it;
`LLM_DAILY_TOKENS` (3M) caps the day.

Secrets: the agent has `place{ref,secret}` and `keep{ref,env}` and is told
which names exist, never values.

## Repair and heal

```sh
pnpm autobrowse repair ~/.config/autobrowse/artifacts/google-x-2026-….failure.json
pnpm autobrowse heal   ~/.config/autobrowse/artifacts/google-x-2026-….failure.json
```

`repair`: the agent picks up on the failed page toward the flow's goal and
records the way through; compile it, splice it in. `heal`: a failed
compiled step is finished by the agent on the page, the step is rewritten
from what it did, the flow is proven again. `AUTO_HEAL=true` does it alone.

## Self-building

The evaluator reads flow failures, agent sessions and recordings and says
which recurring needs deserve a workflow (`/api/agent/proposals`, the
Explore page). `EVALUATE_EVERY_HOURS=6` runs it on a clock;
`AUTO_BUILD=true` explores a proposal seen twice, saves, compiles, proves,
and tells you what got built. Design: `../designs/2026-09-21-healing.md`,
`../designs/2026-09-21-one-verb.md`.

## Model

`LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`, or `openai` (+ `OPENAI_BASE_URL`
for a compatible host), or `claude-code` (headless Claude Code on your
subscription, no key).
