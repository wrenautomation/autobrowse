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
- **Read.** A flow can keep text as well as act: `read {ref, as}` in the
  agent, `read` in explore mode, `fp.read(hints)` in a compiled step. The
  values come back as the step's result, so a workflow scrapes the same
  way it clicks, with no model at run time.
- **Recorded.** `autobrowse record <name>` opens a headed browser with an
  observer: clicks, typing, navigations, each with a screenshot and
  locator hints (role, label, text; never CSS). Typed secrets are redacted
  at capture. `p` pauses (nothing captured), `q` finishes, any other line
  is a note. `--terminal` records the shell leg after. Raw recordings
  stay out of git.
- **Explored.** `autobrowse agent <site> "<goal>"` finds the way itself:
  each step the model sees the URL and a digest of the page (numbered
  controls, headings, a little text; ~700 tokens), picks one act, the
  code runs it and journals it. `done` or `human` ends it; the journal is
  a recording, `compile` makes it a deterministic flow the worker serves
  at once (one `Compiled` object keyed `<workflow>/<key>`, loaded from
  disk per run, so no restart); `autobrowse try <name>` runs it in-process.
  Explore by agent once, then run the flow forever. `pause`/`resume` over loopback lets a
  person step in mid-run: while paused the browser is theirs and every
  click and keystroke lands in the same journal; the agent re-reads the
  page when it resumes. The UI's **Explore** page is the same thing with
  a form, live steps and screenshots, pause/resume/stop, save, compile.
- **Self-repairing.** Every flow failure writes `<stamp>.failure.json`
  (site, URL, last goal, error). `autobrowse repair <that file>` starts
  the agent on that page toward the flow's goal and records the way
  through; compile it, splice it in. The loop: run → fail → explore →
  compile → run.
- **Self-building.** The evaluator (`/api/agent/proposals`, Explore
  page) reads flow failures, agent sessions and recordings and says which
  recurring needs deserve a workflow, each as a site + goal one click from
  an agent session; `EVALUATE_EVERY_HOURS=6` runs it on a clock and
  messages the fresh ones. `AUTO_BUILD=true` goes the last step alone:
  a fresh proposal seen twice or more is explored by the agent, saved,
  compiled, proven (one run on its own, `proof.json` beside the flow, shown on
  the Runs page), and you hear what got built or where it needs you.
  `autobrowse try <name> --prove` or "prove" on the Runs page writes the
  same proof by hand. `LLM_PROVIDER=claude-code` runs every model call through headless Claude
  Code on your subscription, no API key (`designs/2026-09-21-claude-code-driver.md`).
  Every model call counts against `LLM_DAILY_TOKENS`
  (3M a day by default, one ledger for worker and CLI); over it, calls
  fail loudly until UTC midnight, so an unattended night cannot run up a bill. The agent's `human` is a pause with a prompt: do the
  captcha or the purchase in the window, resume, it goes on.
- **Accounts.** A site name may carry an account: `google@ops` is the
  google walk with credential and browser profile `google@ops`. One
  profile per identity, so two accounts never meet in a chooser.
- **Explored.** `autobrowse explore <site> [--url u]`: one hidden browser
  stays open on the site and takes commands over loopback, one at a time
  (`open`, `click`, `fill`, `aria`, `eval`, `pages`/`page` for an OAuth
  popup, `save`, `close`). `aria` dumps
  the page's accessibility tree: every control by role and name, so a
  whole form is mapped in one look instead of one miss per run. Every act
  that works is journaled as a recording; `save` writes it, `compile`
  takes it from there. Failing flows leave the same aria tree next to the
  screenshot (`<stamp>.aria.txt`).
- **Minted secrets.** `{"cmd":"keep","hints":…,"env":"X_API_KEY"}` reads
  a key the site just showed straight into the secret sink (`.env` locally,
  SSM in prod) under that name. The journal keeps the element and the env
  name, never the value; a compiled `keep` op does the same through
  `deps.sink`, outside the run's journal. The agent has `keep{ref,env}`.
- **Env store.** Secrets travel through SSM Parameter Store, one
  SecureString per name under `/autobrowse/config` (KMS at rest, IAM at
  the door, every read in CloudTrail; no extra vendor). `autobrowse env
  push TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN` sends local `.env` keys up;
  `env push --from deploy/prod.env` sends a whole file; the box reads the
  store on every deploy. Back down on any machine with AWS access: `env
  get NAME` puts one value on the clipboard for a minute (Universal
  Clipboard carries it to a phone), `env pull` merges all of them into a
  0600 `.env`, `eval "$(autobrowse env pull --export)"` loads a shell.
  `env ls` prints names only; nothing prints a value unless `--print`.
- **Claude Code.** The skill in `.claude/skills/autobrowse/` teaches
  Claude Code the explore session: `scripts/start.sh <site> [url]`, then
  `scripts/cmd.sh <port> '{"cmd":…}'`, `save`, `stop.sh`. It costs context
  only when invoked; an MCP server's tool schemas would sit in every
  session. `autobrowse mcp` still exists for clients that want tools
  (`claude mcp add autobrowse -- pnpm autobrowse mcp`), off by default.
  Same journal, same redaction, same compile. `LLM_PROVIDER=claude-code`
  is the other direction: Claude Code as the model behind the built-in
  agent. `explore` leaves its bearer token in
  `$TMPDIR/autobrowse/explore-<port>.token` (owner-only) for the session's
  life, never in its output.
- **Payment gate.** A billing field or a button that spends (`src/gates/`)
  is never the session's own call: the act waits on a yes from the person
  over a channel they answer on (phone, Linq, email), and is refused
  outright when no such channel is set. Compiled steps that touch billing
  are gated the same way as irreversible ones; the agent stops on a no.
- **Desktop.** The same session takes `{"cmd":"os","act":{…}}`: apps,
  the front app's controls as a tree (`tree`, like `aria`), `click` by role
  and name, `type`, `key` ("cmd+shift+4", "return"), `shot`, and `shell`
  with `root:true` for a command that needs it. Desktop acts are journaled
  beside browser acts and compile to a `desktop` step that replays through
  `deps.desktop`; typed passwords (`secret:true`) never enter the record.
  Root goes through one audited helper (`autobrowse desktop setup` prints
  the three commands that install it; every root command lands in
  `/var/log/autobrowse-root.log`). macOS grants Accessibility to the app
  running node once, by hand; `desktop setup` says whether it has.
- **Devices.** `PHONE_NUMBER` links your own phone through the Mac it is
  paired with: SMS codes are read from Messages, "tap Yes" nudges go back
  over iMessage. Twilio is the rented-number twin. `setup` checks the two
  one-time macOS switches and opens the pane.
- **Compiled.** `autobrowse compile <name>`: recording → `outline.json`
  (steps at notes and navigations, typed inputs vs secrets, irreversible
  verbs, pauses → hand-offs) → a workflow module plus a test that
  typechecks against the library. A model may polish names and proofs; it
  can never change what runs. Edit the outline (the Workflow page in the
  UI, or the file) and it re-renders; `--from-outline` does the same from the CLI.
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
pnpm autobrowse run bootstrap cloudflare --plan '{"provider":"cloudflare"}'   # mints CLOUDFLARE_ACCOUNT_ID + API token into .env (--plan: JSON, a file, or -)
# map a page by hand or by model: one open browser, one command at a time (token printed at start)
pnpm autobrowse explore cloudflare --url https://dash.cloudflare.com/profile/api-tokens
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9090/ -d '{"cmd":"aria","hints":{"css":"main"}}'
pnpm autobrowse agent google "open Personal info and report the display name" --save google-name   # model explores, journal → recording
pnpm autobrowse repair ~/.config/autobrowse/artifacts/google-x-2026-….failure.json   # agent picks up where a flow stopped
pnpm autobrowse creds paste google@ops            # a second account: `email password [key]` on the clipboard
pnpm autobrowse record buy-domain --site cloudflare --url https://dash.cloudflare.com/ --terminal
pnpm autobrowse compile buy-domain             # → src/workflows/buy-domain/ with its outline.json (on the Runs page at once; no restart)
pnpm autobrowse try google-name                # run a compiled workflow here, no Restate: the proof it is deterministic
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
minutes and hold a profile.

### AWS

`deploy/`: one EC2 box, the image from ECR, secrets in SSM, no inbound port.
With `RESTATE_TUNNEL_NAME` + `RESTATE_ENVIRONMENT_ID` + `RESTATE_CLOUD_REGION`
+ `RESTATE_IDENTITY_KEY` set, the worker dials Restate Cloud's tunnel instead
of listening and registers the tunnel URL itself. `deploy/README.md` is the
runbook; a push to main deploys once the box exists.

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
src/channels/   email, phone (iMessage on this Mac), linq, webhook, inbound command parser
src/deps/       SecretSource, SecretSink (env file / SSM), Shell: what workflows read and write
src/devices/    what a person owns and a second step leans on: the paired phone (SMS in, iMessage out)
src/explore/    explore mode: one open browser, a loopback command API, pause/resume with hand acts journaled
src/agent/      the exploration agent (digest, one act a step), sessions (play/pause, persisted), repair, evaluator
src/workflows/  one dir per workflow; domain + bootstrap hand-written, compiled ones are served as they appear (one `Compiled` object)
src/ui/         Hono API (+ SSE bus, bearer, rate limit) and the static SPA
src/app/        settings, composition root (lazy deps), self-registration, status, sentry, CLI, worker
Dockerfile, compose.yml   the deploy unit; designs/2026-09-19-deploy.md
ui/             React SPA (Vite); ui/dist is served by the worker
designs/        architecture and per-workflow design docs
test/           one file per module; restate.test needs Docker
```

## Channels

Gates, failures and finishes reach the operator on every configured
channel, and a reply on any of them is a command (`yes`, `no`, `pause`,
`play`, `status`, `reset`, optionally `<workflow> <key>`):

- email (a fleet inbox → `NOTIFY_TO`)
- the paired iPhone (`PHONE_NUMBER`; Messages on this Mac, no vendor)
- Linq (`LINQ_API_KEY` + `LINQ_NUMBER`; iMessage from a number we own,
  no Mac; replies arrive at `POST /hooks/linq`, verified with
  `LINQ_WEBHOOK_SECRET`; the same chats serve SMS one-time codes)
- a webhook (`WEBHOOK_URL`)

With `SENTRY_DSN` set, failed runs, failed steps and crashes become
Sentry issues tagged workflow/key/step.

## Coupling to `wren`

Thin: writes the roster to SSM, dispatches wren's deploy, calls its ingress
to start loops. No imports in either direction.

## OAuth sign-in

A site behind "Continue with Google" needs no password of its own:

```sh
pnpm autobrowse creds via new-tool google --url https://new-tool.test/login
pnpm autobrowse login new-tool          # presses the button, signs in as the stored google account
```

Providers live in `src/auth/providers.ts` (google today); a `via`
credential on any site takes that path, spec or not. API consent
(`site setup youtube consent`) is the hand-written `google/oauth-consent`
flow: chooser, unverified-app warning, scope boxes, Continue, until the
loopback redirect. Design: `designs/2026-09-20-oauth-sign-in.md`.

## Site APIs

A service under its own API's shape: `POST /api/sites/linkedin/rest/posts`
takes what LinkedIn's Posts API takes and answers what it answers; `GET
/api/sites/youtube/youtube/v3/videos?part=statistics&id=…` is the Data API.
Behind one route the official API answers when a token is in hand, a browser
flow otherwise (gated reads, community posts). The caller has one client.

```sh
pnpm autobrowse site                        # sites, token state, setup left
pnpm autobrowse site status linkedin        # every route: api | browser | none (why)
pnpm autobrowse site setup youtube oauth-client   # a browser flow on Cloud Console keeps the client id/secret
pnpm autobrowse site setup youtube consent        # OAuth consent in the logged-in profile; refresh token kept
pnpm autobrowse site call linkedin POST /rest/posts --body '{"author":"urn:li:person:…","commentary":"hi"}'
```

Keys and tokens land in the env store (`autobrowse env`) through the same
sink `keep` uses. `OAUTH_PORT` (9400) is the loopback redirect the OAuth
clients register. The same facade is the Restate service `sites`
(`sites/call`, `sites/status`, `sites/setup`) for an orchestrator on the same
Restate (wren's `Content` service): no port on the box, a call queues while
the box is down, a write runs once. Design: `designs/2026-09-21-site-apis.md`.
