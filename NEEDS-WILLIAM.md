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
or `aws login` (below).

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

- **AWS session expired** (2026-09-22 ~07:45 UTC): `aws login` on this Mac;
  until then the box state, SSM env and Terraform cannot be checked from here.

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
