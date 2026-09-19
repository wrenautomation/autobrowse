# provision

Automates the accounts and infrastructure the fleet runs on. Separate from
`wren` (the campaign system) on purpose: different credentials, different
runtime (browser sessions, long waits for a human), different release pace.

## What it does

Everything automated. Where a step spends money, creates an account, or
accepts terms, the flow pauses for approval and resumes on the answer.
Where a captcha or phone check appears, it hands off and resumes. Every
flow can run sandboxed: plan and stop before the first irreversible step.

Flows, each one durable, journaled, idempotent, per unit:

- **Domains** — buy, DNS (MX, SPF, DKIM, DMARC, verification).
- **Google Workspace** — tenant, secondary domains, inboxes, names,
  signatures, send-as, delegation; service-account scopes.
- **Email fleet** — warmup enrollment, roster entry, hand the inbox to
  `wren` (SSM roster + start its loops).
- **Terminal logins** — the CLI auths a new machine or CI needs (gh, aws,
  restate, …).
- **APIs and tokens** — create keys in provider dashboards, store them where
  the consumer reads them (SSM, GitHub secrets, `.env`).

## How

API first where one exists. Recorded browser flows where none does: record
the full flow once, build the step off the recording. An agentic browser is
the fallback when a recorded flow breaks, with screenshots kept on the run.

Durable execution on Restate (approval = an awakeable that waits for days).
Browser via Playwright, in Browserbase or a container. TypeScript, same
toolchain and pins as `wren`.

## Coupling to `wren`

Thin: writes the roster to SSM, calls `wren`'s ingress to start loops.
No imports in either direction.

## Flows built

- **Domain** (`designs/2026-09-19-domain-provision.md`): buy → DNS →
  Workspace → inboxes → signatures → warmup → roster → loops. Gated at the
  purchase; hands off at logins/captchas/consent; dry run available.

## Run

```sh
cp .env.example .env            # fill it
pnpm worker                     # Restate endpoint on :9081
restate cloud env tunnel        # expose it to the shared Restate Cloud env, register it

pnpm provision record cloudflare        # log in once per site (headed browser)
pnpm provision record google-admin
pnpm provision record instantly

pnpm provision domain wren-six.com --inbox will:William:Jin --inbox hello:William:Jin --dry-run
pnpm provision domain wren-six.com --inbox will:William:Jin --inbox hello:William:Jin
pnpm provision status wren-six.com
pnpm provision approve wren-six.com purchase
pnpm provision approve wren-six.com human    # after doing what the email asked
pnpm provision resume wren-six.com           # after a failure
pnpm provision reset wren-six.com
```

`pnpm gates` = lint + typecheck + tests (the Restate test needs Docker).
