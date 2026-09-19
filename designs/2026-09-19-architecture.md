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
| `browser/` | sessions (profiles, Browserbase), per-site lock, flow runner (trace, hand-off, `fp.act`), locate (hints → locator, one priority for run time and rendered source), repair seam (`Repairer`: llm now, Stagehand later) | `clients/http`, `llm` types, `recorder` types |
| `clients/` | one HTTP door; one client per API | nothing |
| `auth/` | credential store (file 0600 / env / layered), TOTP (RFC 6238), code sources (totp, inbox), `SiteLogin`s, `loginProvider`, TOTP enrollment | `browser` types |
| `llm/` | `Llm` seam: anthropic, openai, fake | `clients/http` |
| `memory/` | `Memory` seam: `remember`/`recall`; in-process store, Backboard | `clients/http` |
| `recorder/` | browser + terminal capture → `Recording` on disk, play/pause, redaction | `browser/session` |
| `compiler/` | `Recording` → `outline.json` → workflow module + test; output typechecks against the library (tested) | `recorder` types, `llm`, `browser/locate`, `deps` |
| `deps/` | `SecretSource` (env, memory), `Shell` (local, fake): what compiled workflows depend on | nothing |
| `channels/` | deliver `RunEvent`s (email, webhook, iMessage, memory); parse inbound commands | `engine` types, `memory` types |
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

- `structure(recording)`: deterministic. Steps split at notes (the person
  named what comes next) and at navigations after a gesture. Typed text →
  plan field keyed by label; redacted text → secret key; click whose label
  spends/creates/sends → irreversible (and so its step); pause → `human`
  op; terminal commands → one terminal step, interactive ones flagged.
- `render(outline)`: templates only, every line one the domain workflow
  has by hand. One `defineFlow` per browser step using `fp.act(op, hints,
  {goal, irreversible})`; secrets read with `deps.secrets.get` outside
  `fx.run`; shell output reduced to an exit code before journaling; a gate
  before each irreversible step; a test that dry-runs the recorded example.
- `polish(outline, llm)`: optional. Merges only names, descriptions,
  proofs and `irreversible → true` by step index. Never changes ops,
  fields, order, or clears a flag.
- The outline is saved beside the recording; `compile --from-outline`
  re-renders an edited one without the model.

## Channels

- `Channel.deliver(event)`. Email (Gmail API), webhook (POST JSON),
  iMessage (Linq, webhook-shaped). Several at once.
- Inbound text → `Command`: `yes/approve`, `no/reject`, `pause`, `play`,
  `status`, `reset`, with an optional run key; bare `yes` answers the
  newest open gate. One route on the UI server takes every channel's
  inbound.

## Memory

- `Memory { remember(content, meta), recall(query, limit) }`. Two
  implementations: `memoryStore()` (word overlap, tests and `MEMORY=none`)
  and Backboard (`MEMORY=backboard`, one assistant per deployment named by
  `BACKBOARD_ASSISTANT`).
- What goes in: a repair that worked (`rememberingRepairer` recalls by
  site + goal and offers the hints to the next repairer first), a gate a
  person answered with a note, a step that needed a person. Never a secret,
  never page content beyond the snapshot the repairer already saw.
- Memory is advisory. A recalled hint is tried like any other proposal and
  checked the same way.

## Auth and guards

- Login walls are the runner's to solve. `fp.open` sees a wall, calls the
  `login` hook for the site, then opens the URL again. A captcha, a site
  without a stored credential, or a failed sign-in becomes `NeedsHuman`.
- `SiteLogin` per site: `loggedIn(fp)` and `signIn(ctx)`; `formLogin`
  writes the common shape; `oauthLogin` presses a provider button (popup
  or redirect) and runs `signInToGoogle` on the provider's pages. A site's
  `credential` names which stored credential signs it in: `google` covers
  the admin console and every "Sign in with Google" button. A credential
  with `via: "google"` takes the button. Verified live 2026-09-19:
  Cloudflare through Google. Locator names written `/pattern/i` match
  loosely. A rejected password stops at once (no lockouts).
- Second factors are `CodeSource`s: TOTP from the stored seed (waits out a
  code about to expire), email codes polled from Gmail after the attempt
  started, SMS through the same shape later. `enroll-totp` reads the seed
  off the setup page and stores it, so a site's 2FA is ours from day one.
- Credentials live in `~/.config/autobrowse/credentials.json` (0600,
  AES-256-GCM, key in the macOS login Keychain, made on first use and
  read through `security -i` so it is never an argv) or `AUTOBROWSE_CRED_*`
  env from a Secret. Read at sign-in time; never on a plan, in a memo, or
  in a journal.
- Guards (`engine/guards.ts`) are the named situations a person approves:
  `purchase`, `password` (resetting an existing inbox's password),
  `irreversible` (repairing a locator miss on an irreversible act). Each
  is a gate; a guard that is off answers itself "approved". `GUARDS=none`
  runs unattended. `human` is not a guard: it means code could not do it.

## Credential ladder

- One stored password per provider is the root of trust. From it the
  `bootstrap` workflow mints what the API clients need (Cloudflare: account
  id off the URL, an API token from the dashboard, verified through
  `/user/tokens/verify` before it is stored) and writes it through a
  `SecretSink` (`.env` locally, SSM in prod). The worker's lazy deps pick
  the new value up without a restart.
- Minting is one journaled effect: the token exists in the page, the
  verification call and the sink, never in the journal or a memo.

## Errors and retries

- Inside a step, every side effect runs through `journaled()`: Restate
  retries transient failures with backoff up to five minutes apart for
  about a day, then the step fails with the last message. A lid closing,
  a dropped network, a crashed Chrome (`FlowInterrupted`) are all
  transient: the flow reruns on a fresh session from the persistent
  profile. Nothing browser-side is held across invocations.
- `Unrecoverable` (missing config, bad plan) and `NeedsHuman`/`FlowFailed`
  are terminal on the first throw. They cross the journal as
  `TerminalError` codes 460/461 with a JSON body, and come back out as the
  same class with artifacts intact, so `advance` sees what the step threw.
- Deps are lazy: the worker boots without every credential, and a missing
  one fails the step that needed it, not the process.

## Deploy

- The unit is one container (Playwright base image) plus Restate; see
  `designs/2026-09-19-deploy.md`. The worker self-registers on boot. All
  config is env; `.env` locally, a Secret in Kubernetes. The UI binds
  loopback unless `UI_HOST` or `UI_TOKEN` says otherwise.

## UI

- Hono in the worker process (`src/ui/api.ts`): `/api/workflows` (with a
  JSON schema per plan), `/api/runs`, `/api/runs/:wf/:key` (GET status,
  POST start, POST `approve|reject|pause|play|reset`), `/api/events` (SSE
  over an in-process bus; `after=` resumes), `/api/recordings[/:name
  [/files/*|/compile]]`, `/api/artifacts?path=` (inside `ARTIFACTS_DIR`
  only), `/hooks/inbound` (rate limited; `parseCommand` with known
  workflow names so "yes looks fine" is a note).
- `UI_TOKEN` set: every route needs the bearer and the server binds all
  interfaces. Unset: no auth, loopback only. The SPA keeps the token in
  localStorage and sends it as a header; SSE is read over `fetch`, not
  `EventSource`, so the token never rides a URL.
- React SPA (`ui/`, Vite, hash routes, no router dep): Runs (list, start
  form from the plan schema, dry-run default on), Run (gate card first with
  screenshot and trace, pause/play/reset, step results, plan), Recordings
  (list, screenshots per action, compile → outline + files), a live ticker.
- Built `ui/dist` is served by the worker; `pnpm ui:dev` proxies to it.

## Rules

- Secrets never enter a journal, a memo, a recording, a log line or a URL.
- LLM proposes, deterministic code disposes: every LLM output is checked
  (compiles, matches a schema, or an API read confirms).
- Prod and demo share code; demo-only integrations sit behind settings and
  the `htn-2026` branch holds config, copy and time compression only.
