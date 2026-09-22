# Look before creating an account

William did not remember whether he had ever made an npm account. That is
the normal case, not the odd one: every account setup starts at "maybe it
already exists", and signing up blind ends with a second account, a taken
handle, and a password reset nobody meant to start.

So the question comes first, and it is the same question everywhere.

## The probe

Ask the site to write, then read the inbox. A forgot-password page is
deliberately vague ("if that address is registered, an email has been
sent"); the inbox is not. Nothing is changed either way — a reset link
nobody opens moves no password.

- `src/auth/exists.ts` — `lookForAccount` and `RESET_FORMS`. Three
  verdicts and never a guess: `exists`, `unknown-to-the-site`,
  `cannot-tell` (an inbox this system cannot search, or a form that would
  not submit). Whole-mailbox search first, because an account made in 2021
  answers before anything is sent; then the form; then one poll every 10s
  until the site's window is up.
- `src/browser/flows/reset-mail-probe.ts` — `account/reset-mail-probe`,
  site-agnostic: it is handed the form, fills the address, submits.
- `GmailUserClient.search(inbox, query, max)` — headers of every message
  matching a Gmail query, however old (`recent` caps at 10 and starts at a
  date). Bodies are never read: the question is who wrote and when.
- `lookForSiteAccount` in `src/app/services.ts` wires the three together.
- `autobrowse known <site> [--email …]` asks out loud;
  `autobrowse signup <site>` asks first and refuses an address the site
  already knows unless `--anyway`.

Mapping a new site is two lines in `RESET_FORMS`: where the form is, and
which sender counts as proof.

Live on 2026-09-22: both `jinwilliam.jin@gmail.com` and
`william@wrenautomation.com` answered `unknown-to-the-site` for npm — no
account, no mail, ever.

## npm, end to end

- **Account.** `PUT /-/user/org.couchdb.user:<name>` (what `npm adduser`
  used to call) answers `403 Account creation via legacy auth is
  unavailable`. `npmjs.com/signup` is a DataDome device check that never
  clears — headless, headed, direct, or clicked from `/login` (mapped
  again 2026-09-22). `/login` and `/forgot` load fine, so it is the signup
  page specifically. That leaves the person, for one minute:
  `signup npm --by-hand --handle wrenautomation` opens the page in their
  own browser with the minted password on the clipboard (5 min), then
  `watchForSiteMail` waits for npm's first mail to the inbox — the same
  sender that proves an old account proves a new one — and marks the
  credential made, username = handle, address kept as `codesInbox`.
  No captcha solving or fingerprint spoofing, by decision: a bot check is
  a human gate, and circumventing it risks a ToS ban on the account that
  publishes every Wren package, to save a minute once.
- **Signup without a browser.** `API_SIGNUPS` in `src/auth/signup.ts`:
  sites whose account is made by a call, not a page. npm's is the registry
  PUT. The password never leaves the process — it comes from the sealed
  credential minted a moment earlier. The path is written and tested; npm
  closed the door, so it is dark until they reopen it or another site uses
  it.
- **Sign-in.** `npm` in `src/auth/sites.ts`, mapped live: textbox
  "Username", textbox "Password", button "Sign In". The 2FA page is
  unverified (no account yet).
- **Token.** Granular tokens are website-only — the registry's
  `/-/npm/v1/tokens` mints the classic kind npm is restricting (account
  changes Aug 2026, direct publishing Jan 2027), and no granular endpoint
  exists (`404`). `npm/granular-token` mints one and puts it in the sink as
  `NPM_TOKEN`; `autobrowse site setup npm token` runs it. The flow is
  written from npm's documented UI and **unmapped** — the first run after
  the account exists either works or drops a failure for the repairer.
- **Site API.** `src/sites/npm.ts`: `GET /-/whoami` proves the token.
- A token need now names the step that mints it, for every site, instead
  of telling the person to paste it into `.env`.

## Update, later on 2026-09-22

- William made the account by hand: username `william_jin`, on
  william@wrenautomation.com, with the minted password (`creds copy npm`).
  `creds username <site> <name>` (new) points the credential at the
  handle and keeps the codes inbox; `creds made npm` cleared the need.
- **Sign-in, mapped:** with no 2FA, npm emails a one-time password on every
  login (`/login/email-otp`). `FormLoginSpec.code` now takes a list:
  first the email code, then an authenticator code once one is enrolled.
- **Token, mapped and proven:** `site setup npm token` ran live (headed —
  headless npmjs.com stalls on a Cloudflare check) and kept a 90-day
  granular token as `NPM_TOKEN` in SSM. A token without **Bypass 2FA**
  can read but not publish (npm answers 403 on publish) on an account
  without 2FA, so the flow ticks it. Token names get a timestamp, since npm
  wants them unique.
- Later releases: the mailifier session wires npm trusted publishing
  from CI, so no token is needed after publish #1.

## 2FA and trusted publishing (evening 2026-09-22)

- **2FA on, by security key.** New npm enrollments offer only a security
  key, not an authenticator app. `enroll-passkey npm` walks
  `/settings/<user>/tfa` (Continue → name "autobrowse" → Add security key).
  Our virtual authenticator answers, and "Require 2FA for write actions" is on.
- **Two authenticator fixes, all sites.** WebAuthn refuses a page without
  focus, and a headed window behind other apps has none. So
  every attach turns on CDP focus emulation. Sites refuse a
  signature count they have already seen, and stored counts go stale each
  session. So a loaded key counts from the clock (seconds since 1970).
  Nothing is written back.
- **Recovery codes are a site spec** (`SiteLogin.recoveryCodes`: page,
  unlock button, code pattern), not part of enrollment. `recovery-codes
  <site>` reads and seals them. Enrollment calls it once the page confirms.
  npm has five 64-hex codes behind "Use security key". Only the count prints.
- **Key prompts.** `FormLoginSpec.passkey` answers a key prompt after the
  password; the code steps are skipped after it, since npm's 2FA banner
  would match them. `unlockWithPasskey` clicks the button when a page asks
  again (recovery page, token page, package settings).
- **Trusted publisher.** `site call npm POST /packages/<pkg>/trust`
  (irreversible; browser leg `npm/trusted-publisher`) fills the package's
  Settings form. It is idempotent: a rerun reads the connection back.
  mailifier now trusts `wrenautomation/mailifier:release.yml` with
  `npm publish` allowed. `npm trust list` answers 403 with a bypass
  token (npm restricts them), so the page is the check.

## Where to attack, ranked

1. **Token expiry.** 90 days, then publishing stops. Trusted publishing
   now covers mailifier from CI; the token is only for packages without it.
2. **Headless npmjs.com.** Cloudflare stalled headless once; the 2FA runs
   passed headless. Unproven on the box.
3. **One key, no backup.** The only second factor is the virtual key in the
   credential store; the sealed recovery codes are the way back. A second
   key (a phone passkey) would remove the single point.
4. **Token flow under 2FA is unproven.** It unlocks at open and after
   Generate, but has not run since 2FA went on.
5. **More `RESET_FORMS`.** Every site the fleet signs up for should be in
   the table before its first signup. github, Meta, X, TikTok are the
   obvious next four.
6. **`cannot-tell` is load-bearing.** It is the verdict when the inbox is
   unreadable — so an address on an inbox without consent can never be
   looked up. `accounts` already tracks which inboxes read.
