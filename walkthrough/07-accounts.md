# 7 · Accounts: login, signup, OAuth sign-in

**Goal:** every site signs in by itself; Wren's own accounts get made by the
agent with a password it never sees.

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
pnpm autobrowse signup instagram --email hello@wrenautomation.com --name "Wren Automation" --handle wrenautomation --headed
pnpm autobrowse signup x --email hello@wrenautomation.com --inbox will@wrenautomation.com --name "Wren Automation" --handle wrenautomation
```

Order: a 24-char password is minted and stored sealed under `instagram`
**before** the browser opens; the agent fills the form placing `email`,
`password`, `code` (read from that inbox, or `--inbox` when the address is
an alias, or the phone) and `phone` by name — it never sees them. A captcha
hands off to you in the window (enter to go on). The journal keeps every
placed field redacted, so the compiled flow reads it as a secret by key.

**you:** a phone number for the codes (Twilio number, or `PHONE_NUMBER` =
your iPhone paired with this Mac). Instagram, X and TikTok insist.

## Where credentials go on the box

`pnpm autobrowse creds push <site>` copies one sealed credential into SSM as
`AUTOBROWSE_CRED_<SITE>_USERNAME/_PASSWORD/_TOTP_SECRET`; `--all` sends every
site (canaries stay home). The box reads those first. On a second laptop,
`pnpm autobrowse creds pull` fills the local sealed file from SSM (a site
already there is kept unless `--overwrite`). Passkeys cannot ride in env
(see `../deploy/README.md`).
