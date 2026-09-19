# autobrowse

Browser and account automation for the fleet: domains, Workspace, inboxes,
logins, tokens. Recorded browser flows where no API exists, APIs where one
does, a person in the loop where money, accounts or consent are involved.
Separate from `wren` (the campaign system) on purpose: different
credentials, different runtime (browser sessions, waits for a human),
different release pace.

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
- **Recorded.** `autobrowse record <site> --flow <name>` runs Playwright
  codegen on the site's logged-in profile. The recording is transcribed
  into a typed flow (`src/browser/flows/`) with visible-label selectors;
  the raw recording stays out of git.
- **Play/pause.** `pause` holds before the next step; `play` runs on. A
  dry run stops before the first irreversible step.

## Flows built

- **Domain** (`designs/2026-09-19-domain-flow.md`): check → buy → zone →
  Workspace → verify → mail DNS → DKIM → inboxes → signatures → warmup →
  roster → loops. Gated at the purchase; hands off at logins/consent.

## Run

```sh
cp .env.example .env            # fill it
pnpm worker                     # Restate endpoint on :9081
restate cloud env tunnel        # expose it to the shared Restate Cloud env, register it

pnpm autobrowse record cloudflare              # log in once per site (headed browser)
pnpm autobrowse record google-admin
pnpm autobrowse record instantly
pnpm autobrowse record cloudflare --flow buy   # codegen a flow on the logged-in profile

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

## Layout

```
src/clients/    http.ts (timeouts, retries, safe errors) + one client per API
src/browser/    session (profiles, Browserbase), lock (one flow per site), flow (runner: tracing, hand-offs), flows/
src/flow/       plan (zod), effects (host seam), steps (the domain steps), run (advance / answer / resume)
src/restate/    the DomainProvision object
test/           fakes + flow, http, lock, cloudflare, roster, restate (Docker)
```

## Coupling to `wren`

Thin: writes the roster to SSM, dispatches wren's deploy, calls its ingress
to start loops. No imports in either direction.
