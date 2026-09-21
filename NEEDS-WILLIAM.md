# Needs William

What autobrowse cannot do for itself. Kept current by the agent; strike a
line when it is done. Each says why it is stuck and what one action clears
it. Dated 2026-09-21.

## Done without you tonight (2026-09-22, autobrowse main)

Page outline digest, Outlook site + login + consent, library layers
(`autobrowse/sites|auth|do|agent|flows|llm`, `pnpm build:check`),
`doerFor`/`signInContext`, `do` over command-line tools (`wrangler-deploy`,
`gh-pr-create`, `ffmpeg-convert`) with pick memory, plan-field naming in
the polish pass, `BROWSER=cdp` for Electron apps. Everything still open in
`designs/` waits on a credential, a developer app, funded model credits,
or a real account to prove against. 2026-09-22 later: `creds push <site>`
(laptop credential → SSM, so the box signs in too), `place{secret}` +
`autobrowse signup <site>` (accounts made by the agent, password minted
and sealed first; see "Wren accounts" below), origin binding + secret
audit ledger (`creds audit`; `designs/2026-09-22-secrets-and-money-sandbox.md`),
spend policy (`SPEND_*`, `autobrowse spend`), compiled runs' secrets bound
to their site, canaries (`creds canary stripe` — worth planting one now).
On the wren side the content loop is up: `wren content add|drafts|approve|
redraft|queue start` (posts wait on the platform credentials below).

## Money (your decision)

- **Anthropic API credits.** Console org "William's Individual Org" has
  $0; key `ANTHROPIC_API_KEY` is set locally and in SSM but dead until
  funded. Form: platform.claude.com/settings/billing → Buy credits ($5
  min; card, Apple Pay or Google Pay). The payment gate will text you if
  the agent ever reaches it; you can also just do it by hand.
- **Twilio upgrade + number.** Trial account can't buy a number until a
  phone is verified, and the console now asks an SMS code on every login
  (see Twilio texts below). `TWILIO_NUMBER` unset → SMS-by-Twilio off.
- **Linq** (`LINQ_API_KEY`, `LINQ_NUMBER`, `LINQ_TO`, `LINQ_WEBHOOK_SECRET`):
  paid; only needed when the Mac is not around to read/send texts.
- **Virtual cards vendor.** The sandbox plan wants one card per site with
  its own cap (Privacy.com, or your bank's). Pick one; the rest (placed
  card numbers, origin-bound to the merchant) is built like passwords.

## Phone

- **Twilio texts not reaching this Mac.** Twilio's signup texts (13:44,
  13:53 on 2026-09-20) arrived in Messages; its MFA texts (16:29–16:55)
  did not, so `login twilio` stalls at "no sms code available". Check
  your iPhone for those texts. If they are there: Settings → Messages →
  Text Message Forwarding → enable this Mac. If they are not, Twilio
  rate-limited and a later try will pass.
- Payment-gate replies work (your "yes" at 17:31 landed); the deadline
  is now 30 min and the ask no longer holds a request open.

## This Mac (once, by hand)

- **Accessibility for the terminal app** you run Claude Code from.
  System Settings → Privacy & Security → Accessibility → add/toggle it
  (the pane was opened for you). Until then desktop `os` acts fail with
  "grant Accessibility".
- **Root helper** for `shell {root:true}`: run the three commands
  `pnpm autobrowse desktop setup` prints (needs your sudo password;
  the agent never sees it).

- ~~AWS session expired~~ `aws login` done 2026-09-22; the box's idle
  stop was then seen live in CloudTrail (31 min after the deploy).

## Credentials: laptop and box

- Laptop: `pnpm autobrowse creds paste <site>` with `email password
  [authenticator key]` on the clipboard (cleared after), or the UI's
  Accounts page, or `creds set <site>` with JSON on stdin. Sites:
  `linkedin`, `instagram`, `tiktok`, `microsoft` (Outlook).
- Box: `pnpm autobrowse creds push <site>` copies that sealed credential
  into SSM (`AUTOBROWSE_CRED_<SITE>_*`); the box reads it on its next
  deploy (push to main). Nothing is printed either way.
- Anthropic: say yes again to the credits purchase gate when it asks.

## Wren accounts (Instagram, YouTube, Facebook/Meta, X)

Wren has none of these yet (2026-09-22). `pnpm autobrowse signup <site>
--email <addr> --name "Wren Automation" --handle wrenautomation --headed`
makes one: the password is minted and sealed under `<site>` first, the
agent fills the form placing email/password/code/phone by name, and hands
you the window at a captcha. What each needs from you first:

- ~~An inbox the codes land in~~ done 2026-09-22: `jinwilliam.jin@gmail.com`
  is readable now (the `gmail` site consented as it; Gmail API enabled on
  the Cloud project by the agent; 10 messages read back). Signups default
  to it (`--email jinwilliam.jin@gmail.com`), developer apps and paid things
  too, as you said.
- **will@williamjin.dev** as a signup inbox: `pnpm autobrowse creds paste
  google@will` (that address, its password, its authenticator key), then
  `pnpm autobrowse site setup gmail consent --account will@williamjin.dev`.
  Nothing else; any Google account works this way.
- **william@wrenautomation.com** through the service account needs the
  `gmail.readonly` scope added to its domain-wide delegation on
  admin.google.com. Google asks your passkey for the admin console (the
  virtual one we enrolled is not the one Google wants; it offers no other
  way), so: Admin console → Security → API controls → Domain-wide
  delegation → client `107356403027866983613` → Edit → add
  `https://www.googleapis.com/auth/gmail.readonly` → Authorize. Or consent
  it like any other account (`creds paste google@wren`, `site setup gmail
  consent --account william@wrenautomation.com`).
- **A phone number** for Instagram/X/Facebook verification: the paired
  phone, Linq, or the Twilio number (Twilio is your spend call). Without
  one the agent hands off at the phone step.
- **Instagram**: standalone signup works; make it a professional account
  after (Settings → Account type). Then the Meta app (above).
- **YouTube**: a channel on a wrenautomation.com Google account, not a
  new signup — say which account owns it; `google/youtube-channel-create`
  is the next flow to record (Studio → Create a channel).
- **Facebook Page** (posts via the Graph API): Pages hang off a personal
  profile. Either your own profile makes a "Wren Automation" Page (one
  click, I can drive it headed), or a new profile is made for Wren
  (Meta may ask for ID). Say which.
- **Meta app + ad account** (built 2026-09-22 as the `meta` site: ads,
  Page posts, Instagram publishing, all one token). Needs, in order: (1)
  `creds paste facebook` — the Facebook login that admins the Page and
  the ad account (yours, or Wren's new profile); (2) a Business app on
  developers.facebook.com with Facebook Login for Business, Marketing API
  and Instagram products and redirect `http://127.0.0.1:9400/oauth/callback`
  — `site setup meta developer-app` once `meta-developer-app` is recorded
  (I can drive it headed with you), or make it by hand and `env set
  META_CLIENT_ID` / `META_CLIENT_SECRET`; (3) an ad account with a payment
  method on business.facebook.com — the card is yours to add (the gate
  would stop me at it anyway); (4) `site setup meta consent`. Ads that go
  ACTIVE ask you over the channel with the budget; `SPEND_*` in the env
  store sets what may run without asking. Then from wren: `wren ads launch
  spec.json` (PAUSED) → `wren ads start … --daily 20` → `wren ads insights`
  (wren `designs/2026-09-22-meta-ads.md`).
- **X**: standalone signup with the inbox + phone; then the `x` site
  (built 2026-09-22: posts, media upload, metrics) needs a developer
  account + app at developer.x.com (Free tier posts; reads are paid):
  OAuth 2.0 confidential client, read + write, redirect
  `http://127.0.0.1:9400/oauth/callback`; `env set X_CLIENT_ID` /
  `X_CLIENT_SECRET`, `creds paste x`, `site setup x consent`.
- After each account exists: `creds push <site>` so the box has it, then
  the site API setup (`site setup <site> consent`). `meta` and `x` site
  APIs are built (above); each waits on its developer app.

## Content channels (YouTube, LinkedIn, Instagram, TikTok; wren `designs/2026-09-21-content-channels.md`)

- **LinkedIn login**: the UI's Accounts page (linkedin → add → check), or
  `pnpm autobrowse creds paste linkedin` with `email password
  [authenticator key]` on the clipboard. The `linkedin`
  login and `linkedin/oauth-consent` are written (2026-09-21) but unproven:
  the credential proves them and unlocks the developer-app recording.
- **LinkedIn developer app** (Client ID/secret; products "Share on
  LinkedIn" + "Sign In with LinkedIn using OpenID Connect"): needs a
  LinkedIn Page to attach to. Say which Page, or that I should create
  one for Wren Automation.
- **Instagram** (built 2026-09-21, unproven): a professional (business or
  creator) account, its login via the Accounts page (`instagram`), and a
  Meta app with "Instagram API with Instagram Login" (developers.facebook.com
  → Create app → Business). Then `site setup instagram consent` keeps the
  60-day token. Say which account.
- **TikTok** (built 2026-09-21, unproven): the account's login via the
  Accounts page (`tiktok`), and a developer app at developers.tiktok.com
  with Login Kit + Content Posting API (redirect
  `http://127.0.0.1:9400/oauth/callback`). Posting needs its app review;
  reads work unaudited.
- **Outlook** (built 2026-09-21, unproven): the Microsoft account via the
  Accounts page (`microsoft`), and an app registration at
  entra.microsoft.com (any account type, web redirect
  `http://127.0.0.1:9400/oauth/callback`, a client secret) →
  `MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET` via `autobrowse env`; then
  `site setup outlook consent`.
- **YouTube community post**: `google/youtube-community-post` is mapped
  up to the Post button (2026-09-21). Proving it publishes a real post on
  JinstersJournal: say "post a test" (deleted after) or do the first one
  yourself.
- ~~YouTube~~ done 2026-09-20 with jinwilliam.jin@gmail.com (channel
  JinstersJournal): Cloud project `wren-509223`, OAuth client, consent,
  refresh token kept; the Data API answers. Say if another Google account
  owns the channel you want to post to.

## Sign-in providers

- **GitHub**: Accounts page → add `github` (or `creds set github`, stdin
  JSON `{"username","password","totpSecret"?}`) and "check" to prove the
  new `github` provider live; then any "Continue with GitHub" site is
  `creds via <site> github --url …`. Built and unit-tested 2026-09-20.
- **Microsoft**: same, `microsoft`, if you have an account that
  signs in anywhere. Built and unit-tested 2026-09-20; unproven.

## Keys not yet obtained

- `BROWSERBASE_*`: skipped on purpose (no Browserbase).
- htn-2026 demo branch: waits on a spec beyond "config, copy, time
  compression".
