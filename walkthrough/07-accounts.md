# 7 · Accounts: login, signup, OAuth sign-in

**Goal:** every site signs in by itself; Wren's own accounts get made by the
agent with a password it never sees.

## Which account for what

Several Google accounts, one rule: one pays, one is for everything else.
Tell autobrowse once; every signup, consent and `via` sign-in reads it.

```sh
pnpm autobrowse accounts add jinwilliam.jin@gmail.com --for pays
pnpm autobrowse accounts add william@wrenautomation.com --for default,signup
pnpm autobrowse accounts                 # each account: purposes, credential, inbox readable, tokens
pnpm autobrowse accounts use signup will@williamjin.dev
pnpm autobrowse accounts push            # the box follows the same rule
```

`site setup meta consent` (a paying site) runs as the `pays` account;
`site setup gmail consent` as the default one; `signup instagram` makes
the account with the `signup` address and reads its codes there. Name
`--account` / `--email` to override any of it.

A Workspace inbox needs no consent: with `GOOGLE_WORKSPACE_DOMAIN` set and
the sender service account delegated `gmail.modify` (the exact scope
matters; readonly is not a subset), every address on the domain reads
through it. A Gmail address consents once (`site setup gmail consent`).

## Login

```sh
pnpm autobrowse login cloudflare              # headless: password or the Google button, TOTP/email/SMS code
pnpm autobrowse login linkedin --headed       # watch it
pnpm autobrowse login google@ops              # a second identity: its own profile and credential
```

Known sites (`src/auth/sites.ts`): cloudflare, google, google-admin,
instantly, aws, anthropic, twilio, sentry, linkedin, instagram, facebook, x,
tiktok, outlook. Any other site stored with `creds set|paste` or `creds via`
works too. A wall it cannot pass (hardware key, captcha) throws
`NeedsHuman`: the run waits at gate `human`, you do the thing in the
profile, `approve <workflow> <key> human`.

## OAuth sign-in ("Continue with Google")

```sh
pnpm autobrowse creds via new-tool google --url https://new-tool.test/login
pnpm autobrowse login new-tool                # presses the button, signs in as the stored google account
pnpm autobrowse creds via other-tool google --account ops@x.com --url https://other-tool.test/login
```

Providers: google, github, microsoft (`src/auth/providers.ts`). No password
of the site's own is ever stored.

## Passkeys and TOTP

```sh
pnpm autobrowse enroll-totp cloudflare --url https://dash.cloudflare.com/profile/authentication
pnpm autobrowse enroll-passkey cloudflare
```

`enroll-totp` reads the seed off the setup page, stores it sealed, confirms
with a generated code. `enroll-passkey` makes one with our own authenticator
and keeps it; sign-ins then need no password or code. Neither prints anything.

## Signup (Wren's accounts)

```sh
pnpm autobrowse signup instagram --name "Wren Automation" --handle wrenautomation --headed   # with your `signup` account (autobrowse accounts)
pnpm autobrowse signup x --email hello@wrenautomation.com --inbox will@wrenautomation.com --name "Wren Automation" --handle wrenautomation
```

A signup that stalled runs again with the same address and picks up its
minted password; it refuses when a different account is stored under the
site's name. It also refuses up front when the inbox cannot be read
(`autobrowse needs` says how to make it readable).

Order: a 24-char password is minted and stored sealed under `instagram`
**before** the browser opens; the agent fills the form placing `email`,
`password`, `code` (read from that inbox, or `--inbox` when the address is
an alias, or the phone) and `phone` (or `phoneLocal`, the number without
its country code, for a field with a country picker) by name — it never
sees them. A captcha
hands off to you in the window (enter to go on). The journal keeps every
placed field redacted, so the compiled flow reads it as a secret by key.

**you:** a phone number for the codes (Twilio number, or `PHONE_NUMBER` =
your iPhone paired with this Mac). Instagram, X and TikTok insist.

An account that exists but moved to another address (Wren's Instagram, made
on a Gmail alias, now on william@wrenautomation.com):

```sh
pnpm autobrowse agent instagram 'Change the account email to william@wrenautomation.com; fill the confirmation code with place{secret:"code"}' --url https://www.instagram.com/accounts/edit/ --codes william@wrenautomation.com
pnpm autobrowse creds address instagram william@wrenautomation.com   # the stored login follows
```

`--codes <inbox>` gives any agent run one secret, `code`, read from an
inbox this system reads; nothing else is placed.

Housekeeping on a new account (name, profile photo; no bio, no links —
that is copy, William's): the Wren mark lives at `assets/brand/wren-pfp.png`.

```sh
pnpm autobrowse agent instagram 'Set the profile photo to input pfp and the name to "Wren Automation"; touch nothing else' --url https://www.instagram.com/accounts/edit/ --input pfp=$PWD/assets/brand/wren-pfp.png
pnpm autobrowse run instagram-profile-basics --plan "{\"profilePhotoFile\":\"$PWD/assets/brand/wren-pfp.png\"}"   # the compiled one
```

When the run ends with `achieved` the credential is stamped `madeAt` and
`needs` drops the `signup-<site>` row. Finished it by hand after a
handoff? `pnpm autobrowse creds made <site>` stamps it. Then
`creds push <site>`.

Status 2026-09-22: Instagram made headless end to end (email code, no
captcha). X refuses email signup and loops on the phone dialog: yours
headed. `compile signup-instagram` gives a deterministic two-step flow
(secrets keyed `email`/`password`/`code`; a field retyped in the same step
keeps one key, the last value).

## Where credentials go on the box

`pnpm autobrowse creds push <site>` copies one sealed credential into SSM as
`AUTOBROWSE_CRED_<SITE>_USERNAME/_PASSWORD/_TOTP_SECRET`; `--all` sends every
site (canaries stay home). The box reads those first. On a second laptop,
`pnpm autobrowse creds pull` fills the local sealed file from SSM (a site
already there is kept unless `--overwrite`). Passkeys cannot ride in env
(see `../deploy/README.md`).

A site setup step that bills (`purpose: "pays"`, the Google Cloud console)
runs as the paying account: its profile signs the step's flows in, and the
step's `email` is that address. Name another with `--account`.

In the UI: **Accounts** starts with "Which account for what" (change a
purpose there), **Needs** is `autobrowse needs` with a done button.
