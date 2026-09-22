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

## Where to attack, ranked

1. **The account.** Everything downstream is written and waits on one
   human minute at `npmjs.com/signup`. Then: `creds made npm` →
   `site setup npm token` → `npm publish --access public` for mailifier.
2. **`npm/granular-token` is unmapped.** Expect the first run to need
   repair — the expiry control and the "read and write" radio are guesses.
3. **2FA.** `creds enroll-totp npm` exists generically but has never run
   against npm; npm will likely require it before a granular token with
   write.
4. **More `RESET_FORMS`.** Every site the fleet signs up for should be in
   the table before its first signup. github, Meta, X, TikTok are the
   obvious next four.
5. **`cannot-tell` is load-bearing.** It is the verdict when the inbox is
   unreadable — so an address on an inbox without consent can never be
   looked up. `accounts` already tracks which inboxes read.
