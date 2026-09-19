# autobrowse architecture

The chores nobody has an API for, done once by a person, then done by the
system: record → compile → run → learn. Domains and Workspace are the first
chores; token minting, OAuth consent, terminal logins are the next.

## Layers

Dependencies point down only. A layer never imports one below it in the
table's "may import" column.

| layer | holds | may import |
|---|---|---|
| `engine/` | Workflow/Step types, Effects, gates, `advance`/`applyAnswer`, the generic Restate run object, the `Runs` registry, `RunEvent` | nothing |
| `browser/` | sessions (profiles, Browserbase), per-site lock, flow runner (trace, hand-off), repair seam | `clients/http` |
| `clients/` | one HTTP door; one client per API | nothing |
| `llm/` | `Llm` seam: anthropic, openai, fake | `clients/http` |
| `recorder/` | browser + terminal capture → `Recording` on disk, play/pause, redaction | `browser/session` |
| `compiler/` | `Recording` → outline → workflow source draft | `recorder` types, `llm` |
| `channels/` | deliver `RunEvent`s (email, webhook, iMessage); parse inbound commands | `engine` types |
| `workflows/<name>/` | plan (zod), deps, steps, flows | `engine`, `browser`, `clients` |
| `ui/` | Hono API + React app | `engine` types, `recorder`, `compiler` |
| `app/` | composition root: settings → deps → services; CLI; main | everything |

## Engine

- `defineWorkflow({ name, plan, steps, emptyMemo })`. Step names are a
  literal union inferred from `steps`, so results are typed per workflow.
- A step is idempotent, returns `done | skipped | rejected`, and reads
  gates through `ctx.gate(name, prompt)`: an answer, or `GateOpen`.
- `advance(fx, workflow, deps, plan)` runs one step and says
  `continue | waiting | finished`. `applyAnswer` records an answer. Both
  are pure over `Effects`; the in-memory host runs them in tests.
- The Restate object is generic: `makeRunObject(workflow, deps, host)`,
  named after the workflow, keyed by the run key. One short invocation per
  step (`step{gen}` sends the next). Gates are state. `pause`/`play` flag.
  `reset` bumps the generation. `status` is shared.
- `RunEvent` (`started | step | gate-opened | finished`) is the only thing
  the engine tells the outside; channels render it, the registry projects
  it, the UI streams it.
- `Runs` registry: one object, key `all`; the run object sends it every
  event. The UI lists runs from it.

## Browser

- `defineFlow<I, O>({ site, name, run })`; the runner adds lock, session,
  trace, screenshot, `NeedsHuman` artifacts.
- `fp.act(goal, locator, opts)`: try the recorded locator; on timeout ask
  the `Repairer` for one action from the accessibility snapshot, apply it,
  record the repair as an artifact. `irreversible: true` skips repair and
  asks a person. Stagehand is one `Repairer`; the built-in one is an LLM
  over the aria snapshot.
- A browser step is proved by an API read afterwards where one exists.

## Recorder

- `autobrowse record <name> [--site s] [--terminal]`: headed browser on
  the site's profile with an injected observer (clicks, inputs,
  navigations, key presses, with role/name/text/label hints and a
  screenshot each), a Playwright trace, and optionally a terminal
  transcript (`script`).
- Play/pause from the CLI. Paused = nothing is captured and a `pause`
  marker is written, so a person can type a secret or do a private step.
  Password fields and secret-shaped values are redacted always.
- Output: `recordings/<name>/manifest.json` + screenshots + trace +
  terminal log. Gitignored.

## Compiler

- `structure(recording)`: deterministic. Groups actions into steps at
  navigations and notes, flags irreversible steps by verb (purchase,
  create, generate, delete, confirm, pay), turns inputs into plan fields.
- `render(outline)`: deterministic template → a valid workflow module
  (`defineWorkflow` + one `defineFlow` per browser step + terminal steps),
  a test skeleton, TODO comments where a proof is needed.
- `polish(outline, llm)`: optional. Names steps, proposes API proofs and
  gates. The LLM proposes, the template disposes; output must compile.

## Channels

- `Channel.deliver(event)`. Email (Gmail API), webhook (POST JSON),
  iMessage (Linq, webhook-shaped). Several at once.
- Inbound text → `Command`: `yes/approve`, `no/reject`, `pause`, `play`,
  `status`, `reset`, with an optional run key; bare `yes` answers the
  newest open gate. One route on the UI server takes every channel's
  inbound.

## UI

- Hono in the worker process: `/api/runs`, `/api/runs/:wf/:key` (+
  `approve|reject|pause|play|reset`), `/api/events` (SSE), `/api/artifacts/*`
  (inside `ARTIFACTS_DIR` only), `/api/recordings`, `/api/compile`,
  `/hooks/inbound`. Mutations need `UI_TOKEN`.
- React app: Runs (timeline, open gate with screenshot and trace, controls,
  Browserbase live view when remote), Recordings (list, play/pause state,
  compile), Workflows (what exists, start one).

## Rules

- Secrets never enter a journal, a memo, a recording, a log line or a URL.
- LLM proposes, deterministic code disposes: every LLM output is checked
  (compiles, matches a schema, or an API read confirms).
- Prod and demo share code; demo-only integrations sit behind settings and
  the `htn-2026` branch holds config, copy and time compression only.
