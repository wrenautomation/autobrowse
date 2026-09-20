# Boundary review: autobrowse vs APIs vs wren

Rule (William, 2026-09-20): autobrowse workflows are browser automation.
Anything an API does deterministically, and anything that is an email /
DB / enrichment flow, lives in the wren monorepo.

Reviewed at the end of the overnight build (commit ce109b1). Findings
ranked by how much they cross the line. Nothing moved yet: the moves
touch wren (prod on Restate Cloud + Lambda), so they are a daytime job.

## 1. `domain` workflow: 14 steps, 4 are browser

| step | does | via | belongs |
|---|---|---|---|
| check | RDAP + Cloudflare availability | API | wren (or a tiny CLI) |
| buy | registrar checkout | browser | autobrowse |
| zone | create zone | Cloudflare API | wren |
| workspace-domain | add secondary domain | Directory API | wren |
| verify-domain | TXT token via API + Cloudflare | API | wren |
| mail-dns | MX/SPF/DMARC | Cloudflare API | wren |
| dkim-generate | admin console button | browser | autobrowse |
| dkim-dns | TXT record | Cloudflare API | wren |
| dkim-start | admin console button | browser | autobrowse |
| inboxes | create users | Directory API | wren |
| signatures | send-as signature | Gmail API | wren |
| warmup | Instantly enroll | browser (OAuth consent) | autobrowse |
| roster / loops | wren ingress | API | wren |

Proposal: autobrowse keeps `buy`, `dkim-generate`, `dkim-start`,
`warmup`, `workspace-logo` as flows callable over its ingress (one Restate
object per flow, plan = the flow input). wren gets a `domain` workflow
that calls its own Cloudflare/Directory/Gmail clients and, for the four
browser legs, calls autobrowse and waits. `src/clients/cloudflare.ts`,
`google-admin.ts`, `gmail.ts`, `rdap.ts`, `roster.ts` move to wren with
the steps. What stays in autobrowse's clients: `http.ts`, `twilio.ts`
(SMS codes are sign-in), `wren.ts` (the ingress it reports to).

Cost: two repos change together; the Restate object names are the
contract. Do it with William at the keyboard.

## 2. `bootstrap` workflow: stays

Mints an API token *through the browser* (no API can mint the first
token). Browser-only by nature. Its verify call (`/user/tokens/verify`)
is the proof read the rules ask for, not an API workflow.

## 3. Agent goals: a guardrail, not a move

The evaluator proposes goals from failures. A proposal like "add a DNS
record" would be a browser re-implementation of an API. Added to the
evaluator's prompt: prefer no proposal when the need has an API; say so
in `why`. (See `agent/evaluator.ts` SYSTEM.) Nothing else to cut.

## 4. Clean

`explore`, `agent`, `record`, `compile`, `try`, sessions, credentials,
TOTP/passkeys, devices (phone SMS), guards: all browser-side or sign-in
plumbing. No wren imports anywhere (`clients/wren.ts` is an HTTP contract).

## Browser legs as a service (2026-09-19, late)

The in-repo half of the move is done: `src/engine/browser-service.ts`
registers a Restate service `browser` with handlers `buy`, `dkimGenerate`,
`dkimStart`, `warmup`, `workspaceLogo`, and `flow({name, input})` for any
flow by `site/name` (`BROWSER_FLOWS`). A person needed → terminal 460,
a broken flow → terminal 461, artifacts in the message; anything else
retries under the run objects' schedule. These handler names are the
contract wren calls when it takes over the domain workflow's API steps.
The `domain` run object stays until wren owns the orchestration.

### wren side (2026-09-20, later)

Done on wren branch `provision-domain`, PR #1
(https://github.com/wrenautomation/wren/pull/1), not merged: package
`@wren/provision` with a `Domain/{domain}` virtual object that runs the
same fourteen steps. API effects in `ctx.run`, DNS waits in `ctx.sleep`,
browser legs as calls to `browser` (460/461 → a `human` gate with the
artifacts), gates as state answered by `approve`/`reject`. Roster handoff
appends to the SSM parameter and recycles the Lambda so cold starts load
it, then starts `SendScheduler`/`InboxScheduler` through object clients,
no GitHub redeploy. Once it has run for real once, delete
`src/workflows/domain/` and the API clients here that only it used
(`cloudflare`, `google-admin`, `rdap`, `roster`, `wren`; `gmail` stays
for the code reader).
