# autobrowse

Browser and account automation for the fleet: domains, Workspace, inboxes,
logins, tokens. Recorded browser flows where no API exists, APIs where one
does, a person in the loop where money, accounts or consent are involved.
Separate from `wren` (the campaign system) on purpose: different
credentials, different runtime (browser sessions, waits for a human),
different release pace.

New here: `walkthrough/` is the guided path (setup → secrets → sites →
Meta → Google → explore → agent → accounts → chores → the box) with demos
that run now.

## One verb

```sh
pnpm autobrowse do "upload this to youtube" --input file=talk.mp4 --input title="Talk"
pnpm autobrowse do "list my linkedin posts"
pnpm autobrowse do "rename my google account" --input name=Wren --site google --dry-run
pnpm autobrowse do "deploy this on cloudflare workers" --input dir=./worker
pnpm autobrowse abilities                        # what `do` can pick from, and what is not recorded yet
```

`do` routes a goal to what does it: a site route under its official API
shape, a compiled workflow, a hand-written flow, a command-line tool
(`wrangler-deploy`, `gh-pr-create`, `ffmpeg-convert`; ready when the binary
is on the PATH, `src/do/tools.ts`). What the model picked for earlier goals
is kept (`recordings/.do-picks.json`) and shown to it, so the same ask in
other words lands on the same ability. With nothing ready, the
agent explores the site once; what it achieved is saved and compiled,
under the missing leg's name when a route was waiting on one, so the second
same ask runs deterministically. Gates hold inside every leg. The same verb
is `POST /api/do` (a job; `dryRun` answers at once), the Restate service
`do/run` for wren (`restateDo` in `@wren/core/content`), and the `do` tool
of the MCP server. `src/do/`.

## Hands off

Nothing waits for a person unless a guard says so. Login walls are solved
with stored credentials, TOTP generated in-process, and one-time codes
read from an inbox we control. Guards (`GUARDS`) are the situations a
person still approves: a purchase, a password reset, a locator miss on an
irreversible act. Each is on by default and can be switched off. A `send`
gate (a step that files, posts or sends something in your name; every
compiled irreversible step opens one) is always asked: `approve <workflow>
<key> send`. What stays human: hardware keys, adding a payment method,
captchas until Browserbase takes them.

**The bar for asking.** Try it first. `NEEDS-WILLIAM.md` and the `needs`
rows are only for what a machine cannot hold: your password or passkey,
your money, your taste, your name on a decision — or something autobrowse
tried and failed at repeatedly, with the failures written down. Anything
else, autobrowse does: a flow it has not recorded is a flow to record, a
site with no leg is a leg to build. "Someone should set this up" is never
a row; it is work.

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
  each step the model sees the URL and an outline of the page (`[n]B Save`
  refs, containers kept, rows one line, repeats folded; ~1k chars for a
  GitHub issues page), picks one act, the
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
  Code on your subscription, no API key (`designs/2026-09-21-claude-code-driver.md`);
  `LLM_PROVIDER=cohere` (`COHERE_API_KEY`) goes through Cohere's own v2 door, which
  is the only one that keeps a thinking model's answer apart from its reasoning.
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
- **Placed secrets.** `{"cmd":"place","hints":…,"secret":"password"}`
  fills a field with a value the session holds by name and the socket
  never carries: the agent has `place{ref,secret}` and is told which names
  exist, never their values. `pnpm autobrowse signup instagram --email
  hello@wrenautomation.com --name "Wren Automation" --handle wrenautomation
  --headed` mints a 24-char password, stores the credential sealed under
  `instagram` before the browser opens, and lets the agent make the account
  placing `email`, `password`, `code` (read from that inbox or the phone)
  and `phone`; a captcha hands off to you in the window (enter to go on).
  `--inbox will@…` reads the codes there when the address is an alias.
  The journal keeps every placed field redacted, so the compiled flow reads
  it as a secret by key.
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
- **Origin binding.** A password (or a placed signup secret) only types on
  a host under its site's domains (`src/auth/guard.ts`): the site's home,
  its `origins`, the credential's own URL. Any other host — a redirect, a
  look-alike, a model told to paste it elsewhere — throws `SecretLeak`
  before a keystroke. A compiled workflow's secrets (`deps.secrets`) are
  bound the same way to the flow's own site at run time. Every use,
  allowed or refused, is one line in `~/.config/autobrowse/audit.jsonl`
  (never the value); `pnpm autobrowse creds audit --last 50` reads it.
  `creds canary stripe` plants a tripwire credential: any read of it is a
  refused line in that ledger and a note to you. The ledgers (audit, spend,
  agent steps) are hash-chained (credvault's `chain`: each row carries the
  hash of the one before): `pnpm autobrowse ledger verify` finds an edited,
  dropped or inserted row. Tamper-evident, not tamper-proof; that is what
  the file mode and the box's IAM are for.
- **Payment gate.** A billing field or a button that spends (`src/gates/`)
  is never the session's own call: the act waits on a yes from the person
  over a channel they answer on (phone, Linq, email), and is refused
  outright when no such channel is set. Compiled steps that touch billing
  are gated the same way as irreversible ones; the agent stops on a no.
  The ask carries the amount on the button ("Buy $20 of credits" → 20.00
  USD), else the order total next to it (the last "total"/"amount due"
  line in the block around the button; never a subtotal). `SPEND_ALLOW=anthropic SPEND_AUTO_YES_UNDER=25 SPEND_DAILY_CAP=50
  SPEND_HARD_CAP=500` lets the gate say yes alone to a small purchase on a
  named site while the day's total is under the cap, and refuse anything
  over the ceiling before anyone is asked; a button with no amount is
  always a question. Every decision is a line in
  `~/.config/autobrowse/spend.jsonl`; `pnpm autobrowse spend` reads it.
- **The ledger comes to you.** Both files live on the box's disk, so when
  the box stops itself for idleness it first sends the session's summary
  over the channel (secret uses with every refusal, every gate decision
  with its amount; nothing when nothing happened). `GET /api/ledger?since=`
  serves the same window to the UI/CLI.
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
- **Finished.** `compile <name> --finish` or `finish <name>`: a model does
  the last mile a person did by hand (plan inputs for what the recording
  hard-coded, fill and submit as two steps with a `send` gate between, a
  proof read, a gate test), judged by tsc and the workflow's own test,
  three rounds, originals restored on a give-up. A heal runs it after the
  re-render, before the proof. `designs/2026-09-22-self-finishing-compile.md`.
- **Repaired.** Generated flows act through `fp.act(op, hints, {goal})`. A
  stale locator asks the repairer (a model, later Stagehand) for new hints
  for the same goal, tries once, reports the repair. Irreversible ops are
  never repaired; they hand off.
- **Play/pause.** `pause` holds before the next step; `play` runs on. A
  dry run stops before the first irreversible step.
- **Watched.** The worker serves a UI on `:9080`: runs, the open gate with
  its screenshot, controls, live events, recordings and compile.
  `/hooks/inbound` takes what a person typed on any channel. The header's
  `headed`/`headless` button is the one live setting (`GET`/`PUT
  /api/settings {headless}`): every browser opened from then on follows it;
  `BROWSER_HEADLESS` is only its value at boot. `explore`, `agent`, `repair`
  and `login` take `--headed` when you want to watch one; `record` is always
  headed.
- **Where the browser is.** `BROWSER=local` (a Chrome per site profile),
  `browserbase`, or `cdp` with `BROWSER_CDP_URL=http://127.0.0.1:9222`: a
  browser already running, or an Electron app (new Outlook, Slack, Notion)
  started with `--remote-debugging-port=9222`; its pages are the site, the
  same flows and agent drive them, and nothing of it is closed on the way
  out. The desktop leg for apps that are web pages inside.

## Flows built

- **Domain** (`designs/2026-09-19-domain-flow.md`): check → buy → zone →
  Workspace → verify → mail DNS → DKIM → inboxes → signatures → warmup →
  roster → loops. Gated at the purchase; hands off at logins/consent.
- **Hand-written legs** (`src/browser/flows/`, callable as the Restate
  `browser` service's `flow`): `cloudflare/buy`, `google-admin/dkim-*`,
  `google-admin/workspace-logo`, `instantly/warmup`, `google/oauth-consent`,
  `linkedin/oauth-consent`, `instagram/oauth-consent`, `tiktok/oauth-consent`,
  `outlook/oauth-consent`, `google/youtube-community-post`.
- **Compiled from recordings** (`src/workflows/`): `bootstrap` (mints the
  first Cloudflare token), `google-cloud-project`, `google-cloud-oauth-client`,
  `anthropic-console-api-key`, `workspace-skip-passwords`, `google-name`,
  `aws-port25-request` (EC2 email-limit removal form; the submit is a gate).
- **Logins** (`src/auth/sites.ts`): cloudflare, google, google-admin,
  instantly, aws, anthropic, twilio, sentry, linkedin, instagram, tiktok,
  outlook (the `microsoft` credential); providers google, github, microsoft
  behind any "Continue with …" button.

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
pnpm autobrowse creds paste google@ops            # a second account: `email password [key]` on the clipboard (or the UI's Accounts page)
pnpm autobrowse accounts add ops@x.com --for pays  # which of your accounts is for what (pays, default, signup); consents, signups, `via` read it
pnpm autobrowse accounts                          # each account's purposes and readiness (credential, inbox, tokens); names only
pnpm autobrowse needs                             # what only you can give (logins, keys, consents, phone, money, decisions), each with its check + command
                                                  # (the UI has the same list on its Needs page, and the account policy on Accounts)
pnpm autobrowse needs do login-linkedin           # runs the row's ingestion (clipboard creds, a consent, a setup step); `needs done <id>` for decisions
pnpm autobrowse creds copy google                 # one stored field onto the clipboard for a minute (--field password|username|totp|recovery|previous); never printed
pnpm autobrowse creds password google             # you changed it on the site: type it here twice, echo off; only the store is touched
pnpm autobrowse creds rotate google --ask         # change it on the site itself, to one you type here (no --ask: a random 24-char one)
pnpm autobrowse creds push linkedin               # that stored credential into SSM as AUTOBROWSE_CRED_LINKEDIN_*: the box signs in too
pnpm autobrowse creds push --all                  # every stored site (canaries never travel)
pnpm autobrowse creds pull [sites...]             # the other way, on a second laptop; --overwrite to replace what is here
pnpm autobrowse signup instagram --email hello@wrenautomation.com --name "Wren Automation" --handle wrenautomation --headed
pnpm autobrowse record buy-domain --site cloudflare --url https://dash.cloudflare.com/ --terminal
pnpm autobrowse compile buy-domain             # → src/workflows/buy-domain/ with its outline.json (on the Runs page at once; no restart)
pnpm autobrowse try google-name                # run a compiled workflow here, no Restate: the proof it is deterministic
pnpm autobrowse compile buy-domain --no-llm --from-outline
pnpm autobrowse compile buy-domain --finish     # …then a model finishes it until tsc and its test pass
pnpm autobrowse finish buy-domain --brief "the Buy button charges the card"

pnpm autobrowse domain wren-six.com --inbox will:William:Jin --inbox hello:William:Jin --dry-run
pnpm autobrowse domain wren-six.com --inbox will:William:Jin --inbox hello:William:Jin
pnpm autobrowse workflows                      # what this worker can run
pnpm autobrowse runs --limit 20                # the registry, newest first (--before <cursor> pages)
pnpm autobrowse status domain wren-six.com     # every run is <workflow> <key>
pnpm autobrowse approve domain wren-six.com purchase
pnpm autobrowse approve domain wren-six.com human     # after doing what the email asked
pnpm autobrowse reject domain wren-six.com purchase
pnpm autobrowse pause domain wren-six.com
pnpm autobrowse play domain wren-six.com
pnpm autobrowse run domain wren-six.com        # after a failure: resumes the stored plan
pnpm autobrowse reset domain wren-six.com
pnpm autobrowse desktop                        # the Mac outside the browser: apps, menus, root commands
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
runbook; a push to main deploys once the box exists. The box sleeps between
jobs: `IDLE_STOP_MINUTES` makes the worker stop its own instance once nothing
has needed it, and a caller (wren, `box.sh start`) wakes it.

## Layout

```
src/engine/     workflow/step types, effects seam, guards, run (advance/answer), the Restate run object, Runs registry, events
src/browser/    session (profiles, Browserbase), lock, flow runner (trace, hand-off, fp.act), locate, repair, flows/
src/clients/    http.ts (timeouts, retries, safe errors) + one client per API
src/auth/       site logins, code sources (totp, email), enrollment, the page guard; the vault itself is credvault (keep.ts = our names in it)
src/llm/        Llm seam: anthropic, openai, cohere, claude-code, fake; completeJson; OTLP trace sink
src/memory/     Memory seam: in-process store, Backboard; what repairs and gate answers taught us
src/recorder/   observer (in page), browser + terminal capture, redaction, store
src/compiler/   structure → outline → render (+ polish); output typechecks
src/channels/   email, phone (iMessage on this Mac), linq, webhook, inbound command parser
src/deps/       SecretSink (env file), Shell: what workflows read and write
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

Agent sessions are runs too: rows in the Runs registry and on the live
feed under workflow `agent` (started, one `step` per agent step, finished;
a session that dies with the worker is finished as failed on the next
start). Every step is also a row of the hash-chained step ledger
(`pnpm autobrowse steps --last 50 [--session id]`): model, tokens, act,
outcome, time, host; never a page, a prompt or a value. With
`OTEL_EXPORTER_OTLP_ENDPOINT` (+ `OTEL_EXPORTER_OTLP_HEADERS` for the
vendor's auth, `OTEL_SERVICE_NAME`) every model call is a span over
OTLP/HTTP, one trace per session — Langfuse, Honeycomb, Grafana, Jaeger
take it as is; no SDK, nothing runs without the endpoint. Spans carry
sizes, hashes and token counts, never text (`src/llm/trace.ts`), under the
OpenTelemetry GenAI names (`gen_ai.usage.*`), and the sink flushes when the
process exits so a one-call CLI does not take its batch with it.

Langfuse is the default endpoint, set up the way every key here is — nothing
is copied by hand:

```sh
pnpm autobrowse site setup langfuse project-keys   # mints a key pair in the browser, keeps both
pnpm autobrowse langfuse wire                      # derives the three OTEL names from them
pnpm autobrowse langfuse check                     # the door opens
pnpm autobrowse langfuse recent --minutes 30       # the spans that actually landed
```

`site call langfuse GET /api/public/v2/observations` reads the same spans
through the site facade. Point the OTEL names elsewhere and nothing above
the sink changes.

## Coupling to `wren`

Thin: writes the roster to SSM, dispatches wren's deploy, calls its ingress
to start loops. No imports in either direction.

## OAuth sign-in

A site behind "Continue with Google" needs no password of its own:

```sh
pnpm autobrowse creds via new-tool google --url https://new-tool.test/login
pnpm autobrowse login new-tool          # presses the button, signs in as the stored google account
pnpm autobrowse creds set google@ops    # a second Google account, then:
pnpm autobrowse creds via other-tool google --account ops@x.com --url https://other-tool.test/login
```

Providers live in `src/auth/providers.ts` (google, github, microsoft); a `via`
credential on any site takes that path, spec or not. API consent
(`site setup youtube consent`) is the hand-written `google/oauth-consent`
flow: chooser, unverified-app warning, scope boxes, Continue, until the
loopback redirect. Design: `designs/2026-09-20-oauth-sign-in.md`.

Three resources answer with what you may do to them next: a run
(`GET /api/runs/:workflow/:key`) carries `actions` — the gate's `approve`
and `reject` while one is open, `pause`/`play`, `run`, `reset` — a need
carries the setup step that clears it, and a site carries the setup steps
whose inputs are in hand. Legality lives in state, so an agent reads it
instead of guessing a vocabulary (`src/ui/affordances.ts`). Nothing else is
hypermedia; the site facade keeps each vendor's own shape.

## Site APIs

Which account a site posts as is configuration, not a habit: YouTube writes
(upload, thumbnail, comment, community post) check the token's own channel
against `YOUTUBE_CHANNEL_ID` and refuse when they differ or when it is unset,
so a stale consent cannot put Wren's video on a personal channel. Point it at
another channel and consent as that account to move it.

A service under its own API's shape: `POST /api/sites/linkedin/rest/posts`
takes what LinkedIn's Posts API takes and answers what it answers; `GET
/api/sites/youtube/youtube/v3/videos?part=statistics&id=…` is the Data API.
Behind one route the official API answers when a token is in hand, a browser
flow otherwise (gated reads, community posts). The caller has one client.
Sites: `linkedin`, `youtube`, `instagram` (Graph API, long-lived token),
`tiktok` (Content Posting API; `client_key`), `outlook` (Microsoft Graph:
mail and calendar, `/me/messages`, `/me/sendMail`, `/me/events`), `gmail`
(`/gmail/v1/users/me/...`; proven 2026-09-22), `meta` (one Facebook Login
app: Marketing API campaigns/ad sets/creatives/ads/insights under
`/act_{id}/…`, Page posts/photos/videos with the Page's own token, Instagram
publishing for the Page's professional account), `x` (API v2: `/2/tweets`,
`/2/users/me`, a user's posts, metrics, `/2/media/upload` from a local
image or video — chunked and waited on; OAuth 2.0 with PKCE, the refresh
token rolls on every mint and is kept). Instagram, TikTok, Outlook, Meta
and X are written from the public docs and unproven until a credential
and a developer app exist.

A route that can start spending (`spends`: a campaign, ad set or ad set to
`ACTIVE`, a status update to it) goes through the same payment gate as a
browser "Buy" button before the API leg runs: the spend policy, then the
person, with the request's budget as the amount (`daily_budget: 2000` →
20.00/day). No channel to ask on → refused.

One site, any number of identities: `site setup gmail consent --account
will@x.dev` runs the consent in the `google@<label>` profile whose credential
has that username and keeps the token as `GMAIL_REFRESH_TOKEN__WILL_X_DEV`;
`site call … --account will@x.dev` uses it. A consent without `--account` is
kept under whoever consented too (the site's `identity` call says who). Code
reading and mail sending act as a consented address through its own token,
so any Google inbox works, not only our Workspace (the service account's
domain-wide delegation stays the path for those).

```sh
pnpm autobrowse site                        # sites, token state, setup left
pnpm autobrowse site status linkedin        # every route: api | browser | none (why)
pnpm autobrowse site setup youtube oauth-client   # a browser flow on Cloud Console keeps the client id/secret
pnpm autobrowse site setup youtube consent        # OAuth consent in the logged-in profile; refresh token kept
pnpm autobrowse site setup gmail consent --account will@x.dev   # another account's inbox: token under its own name
pnpm autobrowse site call linkedin POST /rest/posts --body '{"author":"urn:li:person:…","commentary":"hi"}'
```

Keys and tokens land in the env store (`autobrowse env`) through the same
sink `keep` uses. `OAUTH_PORT` (9400) is the loopback redirect the OAuth
clients register. The same facade is the Restate service `sites`
(`sites/call`, `sites/status`, `sites/setup`) for an orchestrator on the same
Restate (wren's `Content` service): no port on the box, a call queues while
the box is down, a write runs once. Design: `designs/2026-09-21-site-apis.md`.

### Chores on those APIs

```sh
pnpm autobrowse unsubscribe --days 30                 # every recent sender with List-Unsubscribe: count, path, latest subject
pnpm autobrowse unsubscribe --yes --keep wrenautomation.com      # leave them: one-click POST, else mailto, else the link in the browser
pnpm autobrowse unsubscribe --yes --only news@x.io,hi@tool.io    # a subset
```

Only mail that says how to leave it is listed (a receipt, a code, a person
has no `List-Unsubscribe`); nothing leaves without `--yes`. The list is
`src/chores/unsubscribe.ts`.

```sh
pnpm autobrowse aws-login --user william              # renew the Mac's AWS CLI session: `aws login --remote` answered from the aws profile
pnpm autobrowse aws-login --user william --overwrite  # …even when the profile holds another identity's (root) session
```

`aws login --remote` prints an authorize URL and waits for a verification
code; the signed-in `aws` browser profile picks the console session and
reads the code off the Copy button (the code view elides it). The code goes
straight into the CLI's stdin: nothing prints it, no file holds it. The
CLI then refreshes its own credentials until the console session expires.
`src/chores/aws-login.ts`, flow `src/browser/flows/aws-cli-login.ts`.

## Use as a library

Every layer is a plain function over explicit parts; only the composers
(`loadSettings`, `sitesFor` defaults, `backendFor`) read the process. Take
the whole thing, one site, or one piece. `pnpm build` emits `dist/` with
types; the subpaths are in `package.json` `exports`.

**The whole thing: one verb.**

```ts
import { doerFor } from "autobrowse/do";
const verb = doerFor({ llm, catalog, browser, sink, sites, agent, compile }); // or doer({...}) over your own legs
await verb.do({ goal: "upload this to youtube", inputs: { file: "talk.mp4" } });
```

Or over HTTP/Restate/MCP from any language: `POST /api/do`, `do/run`, the
`do` tool. Sites, workflows and flows you hand `abilitiesOf` are what it can
route to; anything else the agent explores once.

**One site, your wiring.** The facade takes your env store, HTTP client,
sink, flow catalog and site list; nothing is read from `process.env` unless
you leave `env` out.

```ts
import { sitesFor, youtube } from "autobrowse/sites";
const sites = sitesFor({ sites: [youtube], env: (n) => vault.get(n), sink: vault, http, flows, catalog, browser, oauthPort: 9400 });
await sites.status("youtube");                       // routes: api | browser | none (why); setup left
await sites.setup("youtube", "consent");             // refresh token → your sink
await sites.call("youtube", "GET", "/youtube/v3/videos?part=snippet&mine=true", {});
```

**One piece.** Your own token against a route's API leg; your own consent
page opener against the token exchange; a site login on a page you drive.

```ts
import { youtube, runConsent, accessTokens } from "autobrowse/sites";
const videos = youtube.routes.find((r) => r.path === "/youtube/v3/{resource}");
await videos.api({ resource: "videos", part: "snippet", mine: true }, { token, http });
const mint = accessTokens(http, env);                // refresh token → bearer, cached
await runConsent(spec, { http, env, open: ({ url }) => myBrowser.consent(url), port: 9400 });

import { SITE_LOGINS, signInContext, signInToGoogle } from "autobrowse/auth";
await signInToGoogle(signInContext({ fp, site: "google", cred, credentials, codes }));
import { consentFlow, googleOauthConsent } from "autobrowse/flows";
import { digest, exploreWithAgent } from "autobrowse/agent";
```

Adding a site is one module: a `SiteApi` (routes with `request` schema,
`api` leg, `browser` leg, `setup` steps that say which env names they make
and need) and, when it has a login, a `SiteLogin`. `route()` infers the
input type from the schema. Setup steps are the collectable part: a step is
a recorded flow on the developer console or an OAuth consent, and `setup`
runs it into whichever sink you pass (the `.env`, SSM, your vault).
