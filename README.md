# autobrowse

Browser and account automation for the fleet: domains, Workspace, inboxes,
logins, tokens. Recorded browser flows where no API exists, APIs where one
does, a person in the loop where money, accounts or consent are involved.
Separate from `wren` (the campaign system) on purpose: different
credentials, different runtime (browser sessions, waits for a human),
different release pace.

## Hands off

Nothing waits for a person unless a guard says so. Login walls are solved
with stored credentials, TOTP generated in-process, and one-time codes
read from an inbox we control. Guards (`GUARDS`) are the situations a
person still approves: a purchase, a password reset, a locator miss on an
irreversible act. Each is on by default and can be switched off. What
stays human: hardware keys, adding a payment method, captchas until
Browserbase takes them.

## How it works

- **Durable.** Every flow is a Restate Virtual Object. Each step is one
  short invocation that sends itself the next, so the object is never
  busy for longer than one step: `pause`, `reset`, `approve` always get in.
- **Gated.** A gate is state, not a parked invocation. The step that needs
  an answer stops the run; `approve`/`reject` record the answer and send
  the next step. Restate keeps the state for as long as it takes.
- **Hand-offs.** A browser flow that meets a login, captcha or consent
  throws `NeedsHuman`. The runner saves a screenshot and a Playwright trace,
  the run waits at gate `human`, the person does the thing in the
  persistent profile and approves; the step reruns.
- **Verified.** A browser step is proved by an API read afterwards (the
  purchase by the Registrar API, DKIM by the record's shape, the user by
  Directory). The trace is for the person; the API read is for the machine.
- **Recorded.** `autobrowse record <name>` opens a headed browser with an
  observer: clicks, typing, navigations, each with a screenshot and
  locator hints (role, label, text; never CSS). Typed secrets are redacted
  at capture. `p` pauses (nothing captured), `q` finishes, any other line
  is a note. `--terminal` records the shell leg after. Raw recordings
  stay out of git.
- **Explored.** `autobrowse explore <site> [--url u]`: one hidden browser
  stays open on the site and takes commands over loopback, one at a time
  (`open`, `click`, `fill`, `aria`, `eval`, `save`, `close`). `aria` dumps
  the page's accessibility tree: every control by role and name, so a
  whole form is mapped in one look instead of one miss per run. Every act
  that works is journaled as a recording; `save` writes it, `compile`
  takes it from there. Failing flows leave the same aria tree next to the
  screenshot (`<stamp>.aria.txt`).
- **Devices.** `PHONE_NUMBER` links your own phone through the Mac it is
  paired with: SMS codes are read from Messages, "tap Yes" nudges go back
  over iMessage. Twilio is the rented-number twin. `setup` checks the two
  one-time macOS switches and opens the pane.
- **Compiled.** `autobrowse compile <name>`: recording → `outline.json`
  (steps at notes and navigations, typed inputs vs secrets, irreversible
  verbs, pauses → hand-offs) → a workflow module plus a test that
  typechecks against the library. A model may polish names and proofs; it
  can never change what runs. Edit the outline, `--from-outline` again.
- **Repaired.** Generated flows act through `fp.act(op, hints, {goal})`. A
  stale locator asks the repairer (a model, later Stagehand) for new hints
  for the same goal, tries once, reports the repair. Irreversible ops are
  never repaired; they hand off.
- **Play/pause.** `pause` holds before the next step; `play` runs on. A
  dry run stops before the first irreversible step.
- **Watched.** The worker serves a UI on `:9080`: runs, the open gate with
  its screenshot, controls, live events, recordings and compile.
  `/hooks/inbound` takes what a person typed on any channel.

## Flows built

- **Domain** (`designs/2026-09-19-domain-flow.md`): check → buy → zone →
  Workspace → verify → mail DNS → DKIM → inboxes → signatures → warmup →
  roster → loops. Gated at the purchase; hands off at logins/consent.

## Run

```sh
cp .env.example .env            # fill it
pnpm ui:build                   # the SPA the worker serves
pnpm worker                     # Restate endpoint on :9081, UI + API on :9080
restate cloud env tunnel        # expose it to the shared Restate Cloud env, register it
pnpm ui:dev                     # SPA with hot reload on :5173, proxied to :9080

pnpm autobrowse setup                          # asks once for what is missing (hidden input, sealed store)
pnpm autobrowse login cloudflare               # signs in by itself: password or the Google button, TOTP/email/SMS code
pnpm autobrowse workspace-logo logo.png   # the org logo across Gmail/Calendar/Drive (320×132 PNG < 30 KB)
pnpm autobrowse enroll-totp cloudflare --url https://dash.cloudflare.com/profile/authentication  # reads the seed, stores it, confirms
echo '{"provider":"cloudflare"}' > /tmp/bootstrap.json
pnpm autobrowse run bootstrap cloudflare --plan /tmp/bootstrap.json   # mints CLOUDFLARE_ACCOUNT_ID + API token into .env
# map a page by hand or by model: one open browser, one command at a time (token printed at start)
pnpm autobrowse explore cloudflare --url https://dash.cloudflare.com/profile/api-tokens
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9090/ -d '{"cmd":"aria","hints":{"css":"main"}}'
pnpm autobrowse record buy-domain --site cloudflare --url https://dash.cloudflare.com/ --terminal
pnpm autobrowse compile buy-domain             # → recordings/buy-domain/outline.json, src/workflows/buy-domain/
pnpm autobrowse compile buy-domain --no-llm --from-outline

pnpm autobrowse domain wren-six.com --inbox will:William:Jin --inbox hello:William:Jin --dry-run
pnpm autobrowse domain wren-six.com --inbox will:William:Jin --inbox hello:William:Jin
pnpm autobrowse status wren-six.com
pnpm autobrowse approve wren-six.com purchase
pnpm autobrowse approve wren-six.com human     # after doing what the email asked
pnpm autobrowse pause wren-six.com
pnpm autobrowse play wren-six.com
pnpm autobrowse resume wren-six.com            # after a failure
pnpm autobrowse reset wren-six.com
```

`pnpm gates` = lint + typecheck + tests (the Restate test needs Docker).
`pnpm test:live` runs the calls that cost money (Backboard, the configured
LLM) when `.env` has the keys; skipped otherwise.

### Containers

```sh
docker compose up -d --build    # Restate + worker; .env supplies every secret
open http://localhost:9080      # UI (host side is loopback-only)
HOST_INGRESS_PORT=18080 HOST_ADMIN_PORT=19070 HOST_UI_PORT=19080 docker compose up -d   # beside another Restate
```

The worker registers itself with Restate on start (`RESTATE_ADMIN_URL` +
`RESTATE_ENDPOINT_URL`). `wren` is Lambda behind Restate Cloud;
autobrowse is a long-lived container because browser steps run for
minutes and hold a profile. `designs/2026-09-19-deploy.md` has the AWS /
Kubernetes path.

## Layout

```
src/engine/     workflow/step types, effects seam, guards, run (advance/answer), the Restate run object, Runs registry, events
src/browser/    session (profiles, Browserbase), lock, flow runner (trace, hand-off, fp.act), locate, repair, flows/
src/clients/    http.ts (timeouts, retries, safe errors) + one client per API
src/auth/       credentials (file/env/layered), TOTP, code sources (totp, email), site logins, TOTP enrollment
src/llm/        Llm seam: anthropic, openai, fake; completeJson
src/memory/     Memory seam: in-process store, Backboard; what repairs and gate answers taught us
src/recorder/   observer (in page), browser + terminal capture, redaction, store
src/compiler/   structure → outline → render (+ polish); output typechecks
src/channels/   email, webhook, inbound command parser
src/deps/       SecretSource, SecretSink (env file / SSM), Shell: what workflows read and write
src/devices/    what a person owns and a second step leans on: the paired phone (SMS in, iMessage out)
src/explore/    explore mode: one open browser, a loopback command API, a journal that compiles
src/workflows/  one dir per workflow: plan, deps, steps, index (domain, bootstrap = the credential ladder)
src/ui/         Hono API (+ SSE bus, bearer, rate limit) and the static SPA
src/app/        settings, composition root (lazy deps), self-registration, CLI, worker
Dockerfile, compose.yml   the deploy unit; designs/2026-09-19-deploy.md
ui/             React SPA (Vite); ui/dist is served by the worker
designs/        architecture and per-workflow design docs
test/           one file per module; restate.test needs Docker
```

## Coupling to `wren`

Thin: writes the roster to SSM, dispatches wren's deploy, calls its ingress
to start loops. No imports in either direction.
