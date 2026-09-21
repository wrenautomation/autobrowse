# 1 · Secrets and money

**Goal:** every credential sealed and bound to its site; nothing spends
without a yes; the ledger reaches you.

## Credentials

```sh
pnpm autobrowse setup                     # asks once, hidden input, for the root credentials sites need
pnpm autobrowse creds paste google        # clipboard holds `email password [authenticator key]`; emptied after
pnpm autobrowse creds paste google@ops    # a second identity: its own profile, its own credential
pnpm autobrowse creds list                # names only, never values
pnpm autobrowse creds push linkedin       # this credential into SSM so the box signs in too
```

Stored in `~/.config/autobrowse/credentials.json`, sealed with the login
Keychain when `CREDENTIALS_CIPHER=keychain`. Nothing prints a value. `creds
rotate` changes a site's password to a random one — only when you ask.

TOTP and one-time codes are code paths, not a person: `enroll-totp <site>`
reads the seed off the setup page and stores it; email codes come from
`CODES_INBOX` or the credential's own `codesInbox`; SMS from the paired
iPhone (`PHONE_NUMBER`) or Twilio.

## Origin binding

A password types only on a host under its site's domains (`src/auth/guard.ts`).
Any other host throws `SecretLeak` before a keystroke. The same holds for
placed signup secrets and a compiled workflow's `deps.secrets`.

```sh
pnpm autobrowse creds audit --last 20     # every use: site, host, allowed | REFUSED
pnpm autobrowse creds canary stripe       # a tripwire: any read of it is a REFUSED line and a note to you
```

## Money

A billing field or a button that spends never runs on the session's own say.
The gate (`src/gates/`) reads the amount off the button or the order total,
then:

1. `SPEND_HARD_CAP` — over it: refused before anyone is asked.
2. `SPEND_ALLOW` + `SPEND_AUTO_YES_UNDER` + `SPEND_DAILY_CAP` — a named site,
   a small amount, the day's total under the cap: yes on its own.
3. Otherwise: a question on your channel (phone, Linq, email). No channel
   set → refused.

```sh
# .env
SPEND_ALLOW=anthropic,twilio
SPEND_AUTO_YES_UNDER=25
SPEND_DAILY_CAP=50
SPEND_HARD_CAP=500
```

API routes that start spend (a Meta campaign/ad set/ad going ACTIVE) go
through the same gate with the request's budget as the amount.

```sh
pnpm autobrowse spend --last 20           # auto | person | denied | over-cap, with amounts
```

## The ledger comes to you

Both files live on the box. Before it stops itself for idleness it sends the
session's summary over the channel: refused secret uses, every gate decision
with its amount; nothing when nothing happened. `GET /api/ledger?since=<iso>`
serves the same window.

## Moving secrets between machines

```sh
pnpm autobrowse env ls                    # names + changed-at, never values
pnpm autobrowse env push ANTHROPIC_API_KEY    # local .env → SSM /autobrowse/config
pnpm autobrowse env push --from deploy/prod.env
pnpm autobrowse env pull                  # SSM → 0600 .env (merged)
pnpm autobrowse env get META_ACCESS_TOKEN # to the clipboard for a minute
```

The box reads the store on every deploy. Design:
`../designs/2026-09-22-secrets-and-money-sandbox.md`.
