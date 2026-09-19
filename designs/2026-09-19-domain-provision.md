# Domain provision

One new sending domain, end to end: bought, on DNS, in Workspace, with
inboxes, signed, warming, on wren's roster, loops running. One command,
approval where money changes hands, a hand-off where a human must click.

## The flow

`DomainProvision/{domain}` is one Restate Virtual Object per domain. `run`
walks the steps below in order; each is a journaled step, idempotent (get
before create), and records `done | skipped | planned | needs-human |
rejected | failed`. A rerun (`provision resume`) skips what is done and
retries the rest. State: the plan, the results, a memo of what later steps
need (zone id, DKIM record), and the open gate.

| step | does | how | irreversible |
|---|---|---|---|
| check | owned here? free? | Cloudflare Registrar API; RDAP (404 = free) | |
| buy | purchase | **gate `purchase`** → browser: Cloudflare dashboard (no purchase API) | yes |
| zone | Cloudflare zone id (create if missing) | API | |
| workspace-domain | add as secondary domain | Directory API | |
| verify-domain | Site Verification token → TXT → poll verify (10 min) | API + Cloudflare API | |
| mail-dns | MX `smtp.google.com`, SPF, DMARC `p=none` (+rua) | Cloudflare API | |
| dkim-generate | generate the 2048-bit key | browser: admin console (no API) | |
| dkim-dns | `google._domainkey` TXT | Cloudflare API | |
| dkim-start | wait 2 min, "Start authentication" | browser: admin console | |
| inboxes | create users; password → SSM `/provision/inboxes/{email}/password` | Directory API | yes |
| signatures | send-as signature | Gmail API as each user (DWD), retried while the mailbox provisions | |
| warmup | add to Instantly | browser: opens the add dialog, **hands off** the Google consent | |
| roster | append `[[senders]]` to SSM roster, dispatch wren deploy, wait | SSM + GitHub API | yes |
| loops | `SendScheduler/{addr}/start`, `InboxScheduler/{addr}/start` | wren ingress | yes |

Dry run stops before the first irreversible step and reports `planned`.

## Gates and hand-offs

- A **gate** is an awakeable: the run parks, an email goes to `NOTIFY_TO`
  with the command to answer, and Restate holds the wait for as long as it
  takes. `provision approve <domain> <gate>` / `reject`.
- A browser step that meets a login wall, captcha or verification throws
  `NeedsHuman` with a screenshot. The run marks the step `needs-human`,
  mails the screenshot path, parks at gate `human`, and on approve retries
  that step. The human does the thing in the persistent profile
  (`provision record <site>` opens it headed).
- `cancel` (shared handler) ends a parked run; it forgets itself. `reset`
  clears a finished one.

## Browser layer

Playwright. Local tier: a persistent Chromium profile per site under
`PROFILES_DIR` (logins survive). Browserbase tier: a persistent context
per site. Flows use visible labels as selectors, so a redesign fails loudly
with a screenshot, never silently.

The three flows (`cloudflare-buy`, `google-dkim`, `instantly-warmup`) were
written from the dashboards as of 2026-09-19 and are **unverified until
the first real run**. Expect to adjust selectors once each.

## Coupling to wren

Two writes, no imports: the roster parameter, and the ingress `start`
calls. wren reads the roster at Lambda cold start, so the roster step
dispatches wren's deploy workflow (`workflow_dispatch`) and waits for it
before starting loops.

## Secrets

`GOOGLE_SERVICE_ACCOUNT` (the wren key; DWD scopes must include
`admin.directory.domain`, `admin.directory.user`, `siteverification`,
`gmail.settings.basic`, `gmail.send`), `GOOGLE_ADMIN_USER` (a super admin),
`CLOUDFLARE_API_TOKEN` (Zone:Edit, DNS:Edit, Registrar:Read),
`CLOUDFLARE_ACCOUNT_ID`, `GITHUB_TOKEN` (actions:write on wren), AWS creds
with SSM read/write on `/wren/prod/senders_config` and
`/provision/inboxes/*`. Passwords never enter the journal or the memo:
generated, applied and stored inside one journaled step.

## Deploy

Now: the worker runs where a browser can (this machine, or a container),
registered with the shared Restate Cloud env through `restate cloud env
tunnel`. Later: Lambda for the API steps and Browserbase for the browser
ones, like wren. Not needed until a run is unattended.

## Decisions

- 2026-09-19 Everything automated, gated where irreversible (William).
  Manual-by-default was proposed and declined.
- 2026-09-19 Separate repo; thin coupling to wren (both).
- 2026-09-19 Cloudflare stays registrar + DNS; purchase is a browser flow
  because there is no API for it.
- 2026-09-19 Instantly consent is a hand-off, not automated: it is the
  inbox's own Google session giving OAuth consent.
- 2026-09-19 Passwords go generation → Directory → SSM inside one step.

## Open

- First real run: fix the three browser flows against the live dashboards.
- Postmaster Tools registration for the new domain (browser; no API).
- Tenant creation, terminal logins, API tokens: later flows, same shape.
