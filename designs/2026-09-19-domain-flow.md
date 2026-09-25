# Domain flow

One new sending domain, end to end: bought, on DNS, in Workspace, with
inboxes, signed, warming, on wren's roster, loops running. One command,
approval where money changes hands, a hand-off where a person must click.

## The steps

`DomainProvision/{domain}` is one Restate Virtual Object per domain. Each
step is idempotent (get before create) and records `done | skipped |
planned | needs-human | rejected | failed`. A rerun (`resume`) skips what
is done and retries the rest. State: the plan, the results, a memo of what
later steps need, the gate answers, the open gate, paused, generation.

| step | does | how | proof | irreversible |
|---|---|---|---|---|
| check | owned here? free? price? | Registrar API `domain-check` | | |
| buy | purchase | **gate `purchase`** (shows the price) → Registrar API `registrations`, polled | Registrar API lists it | yes |
| zone | Cloudflare zone id (create if missing) | API | | |
| workspace-domain | add as secondary domain | Directory API | | |
| verify-domain | Site Verification token → TXT → poll (10 min) | API + Cloudflare API | | |
| mail-dns | MX `smtp.google.com`, SPF, DMARC `p=none` (+rua) | Cloudflare API | | |
| dkim-generate | generate the key | browser: admin console (no API) | value matches `v=DKIM1;` | |
| dkim-dns | `google._domainkey` TXT | Cloudflare API | | |
| dkim-start | wait 2 min, "Start authentication" | browser | console shows "Authenticating email" | |
| inboxes | create users; password → credential `google@{email}` (SSM + local copy) | Directory API | | yes |
| signatures | send-as signature | Gmail API as each user, retried while the mailbox provisions | | |
| authenticator | enroll TOTP; seed → the same credential | browser as `google@{email}` | Google says the authenticator is on | |
| warmup | Instantly OAuth session → Google consent as the inbox → warmup on | Instantly API + browser | session `success`, warmup job `success` | |
| roster | append `[[senders]]` to SSM roster, dispatch wren deploy, wait | SSM + GitHub API | deploy run succeeded | yes |
| loops | `SendScheduler/{addr}/start`, `InboxScheduler/{addr}/start` | wren ingress | `running: true` | yes |

Dry run stops before the first irreversible step and reports `planned`.

## The object

```
run(plan?)   validate, store, gen+1, send step{gen}
step{gen}    ignore if gen stale or paused; advance one step;
             continue → send step{gen} | waiting → notify | finished → store outcome, notify
approve/reject{name}   record the answer (purchase: kept for the step; human: step reruns),
                       send step{gen}; reject ends the run
pause / play           flag; play sends step{gen} unless a gate is open or the run is over
reset                  clearAll, gen+1 (a step message in flight lands on a dead generation)
status (shared)        plan, gate (with screenshot/trace), paused, outcome or the results so far
```

No invocation ever parks. The longest an exclusive handler holds the key
is one step (a browser flow, minutes at most; DNS polls sleep durably
between checks). So `pause`, `reset`, `approve` never wait on the run.

## Browser layer

- `session.ts`: local = a persistent Chromium profile per site under
  `PROFILES_DIR`; Browserbase = a persistent context per site. Opened per
  flow run, closed after.
- `lock.ts`: `KeyedMutex`, one flow per site at a time in this process (a
  profile cannot be open twice). Different sites run in parallel.
- `flow.ts`: `defineFlow<I, O>({site, name, run})` + `flowRunner`. The
  runner takes the site lock, opens the session, starts a Playwright
  trace, runs the flow, and on any throw saves a screenshot and the trace
  under `ARTIFACTS_DIR`, attaches them to `NeedsHuman` or wraps the error
  in `FlowFailed`. Flows call `fp.open(url)` (refuses walls) and
  `fp.human(reason)`.
- `flows/`: `google-dkim` (generate, start); the inbox steps reuse
  `google/oauth-consent` (pass-through) and `enroll-totp`, run in the
  inbox's own profile. Written from the dashboards on 2026-09-19,
  **unverified until the first real run**. `record --flow` exists to
  replace guesses with recordings.

Stagehand (Browserbase's LLM-driven `act`/`observe`) is not used: it adds
a paid model call and non-determinism to every step. Recorded flows with
API proofs are deterministic and free. It stays an option as a fallback
layer when a recorded selector drifts, behind the same `BrowserFlow` type.

## Design choices asked for

- **Typing.** `BrowserFlow<I, O>` is typed end to end; a fake is
  registered per flow object, so a test cannot fake a flow that does not
  exist. `StepName`, `GateName` are unions; results are
  `Partial<Record<StepName, StepResult>>`. Plans are zod at the edge, then
  plain types inside.
- **Concurrency.** Restate serialises per key. Across keys the process is
  concurrent; the only shared mutable resources are browser profiles
  (mutex per site) and token caches (one supplier per subject+scopes,
  refreshed a minute early). No worker threads: the work is I/O-bound
  waits, not CPU.
- **Memory/time.** State per object is a few KB; the memo never holds a
  secret. The Cloudflare client caches zone names (one GET per zone, not
  per record). Token suppliers cache bearers. Journals stay short because
  waits are `sleep`, not spinning.
- **HTTP.** One client for every API: per-attempt timeout, retries on
  429/5xx/network for idempotent methods, POST only on 429, full-jitter
  backoff honouring Retry-After. Errors carry method + origin + path,
  never a query string, header or body.
- **State, not a DB.** Restate object state is the store; SSM holds
  secrets and the roster. No schema to migrate. If runs need querying
  across domains later, that is a Postgres table written from `step`.
- **Tests alongside.** Flow tests run the real steps against fakes; the
  Restate test runs the real object in Docker; http, lock, cloudflare,
  roster have their own.

## Secrets

`GOOGLE_SERVICE_ACCOUNT` (the wren key; DWD scopes must include
`admin.directory.domain`, `admin.directory.user`, `siteverification`,
`gmail.settings.basic`, `gmail.send`), `GOOGLE_ADMIN_USER` (a super admin),
`CLOUDFLARE_API_TOKEN` (Zone:Edit, DNS:Edit, Registrar:Read),
`CLOUDFLARE_ACCOUNT_ID`, `GITHUB_TOKEN` (actions:write on wren), AWS creds
with SSM read/write on `/wren/prod/senders_config` and the credential
store, `INSTANTLY_API_KEY` (scopes accounts:all; env or env store; the
warmup step asks a person while it is missing). Passwords never enter the journal or the memo:
generated, applied and stored inside one journaled step. Raw recordings
(`RECORDINGS_DIR`) may hold typed secrets and are gitignored.

## Deploy

Now: the worker runs where a browser can (this machine, or a container),
registered with the shared Restate Cloud env through `restate cloud env
tunnel`. Later: Lambda for the API steps and Browserbase for the browser
ones, like wren. Not needed until a run is unattended.

## Decisions

- 2026-09-19 Everything automated, gated where irreversible (William).
  Manual-by-default was proposed and declined.
- 2026-09-19 Separate repo; thin coupling to wren.
- 2026-09-19 Cloudflare stays registrar + DNS; purchase is a browser flow.
- 2026-09-25 Purchase moved to Cloudflare's Registrar API (beta since
  2026-04): price in the gate, no dashboard guessing, RDAP dropped. A rerun
  follows a registration already started and never buys twice. The
  guessed `cloudflare/buy` flow is gone. Unproven until the first buy: that
  the token's "Registrar: Domains Admin" covers `registrations` (a 403 fails
  the step, nothing is charged).
- 2026-09-25 `autobrowse domains <brand words>`: the brand's spellings
  (joined, hyphen, plural, hq/team) × com/net/org/co/io, each marked ours,
  free with price, or (`--all`) why not. No .us (needs US nexus).
- 2026-09-19 Instantly consent is a hand-off: it is the inbox's own Google
  session giving OAuth consent. Superseded 2026-09-25.
- 2026-09-19 Passwords go generation → Directory → SSM inside one step.
- 2026-09-25 Each inbox is a first-class account: credential and browser
  profile `google@<email>`, password then TOTP seed, so the runner signs
  it in anywhere with nobody. Google's first-sign-in terms page ("I
  understand") is answered in `signInToGoogle`. No backup codes: we are
  the Workspace admin and can reset.
- 2026-09-25 Warmup through Instantly's OAuth session API
  (`/oauth/google/init` → consent → `/oauth/session/status`), not the
  dashboard: no Instantly login, one API key. The consent runs
  pass-through so Instantly's callback sees the code. Init, consent and
  the poll are one journaled unit (the session lives 10 minutes); a rerun
  asks Instantly first, so an inbox is never connected twice. Unproven
  until the first real inbox.
- 2026-09-19 Gates are state + self-chained steps, not awakeables: a
  parked invocation blocked `pause`/`reset` and held the key for days.
- 2026-09-19 Recording-first for browser flows; Stagehand not adopted.
- 2026-09-19 Renamed `provision` → `autobrowse` (the name should say
  "browser").

## Open

- First real run: replace the three guessed flows with recordings.
- Postmaster Tools registration for the new domain (browser; no API).
- Terminal logins (gh, aws, restate) and API-token creation: same shape.
