# Needs William

What autobrowse cannot do for itself. Kept current by the agent; strike a
line when it is done. Each says why it is stuck and what one action clears
it. Dated 2026-09-21.

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

## AWS (one `aws login`, then two applies)

- **Box sleeps on its own** (idle stop + wake, 2026-09-20). Code is live;
  the IAM is not. Run: `cd autobrowse/deploy/terraform && tofu apply`
  (instance role may stop itself; IMDS hop limit 2), then in wren
  `deploy/terraform`: set `autobrowse_instance_id` in `terraform.tfvars`
  (`tofu output -raw instance_id` from autobrowse) and `tofu apply`
  (Lambda may start it). Then `IDLE_STOP_MINUTES=30` into the env store
  (`pnpm autobrowse env push IDLE_STOP_MINUTES` after adding it to `.env`)
  and one deploy. Until then the worker warns "idle stop failed" once per
  span and the box stays as it is (stopped after each deploy, started by
  `box.sh start`).

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

## Content channels (YouTube + LinkedIn; wren `designs/2026-09-21-content-channels.md`)

- **LinkedIn login**: `pnpm autobrowse creds paste linkedin` with
  `email password [authenticator key]` on the clipboard. No LinkedIn
  credential is stored, so no LinkedIn flow can be explored yet.
- **LinkedIn developer app** (Client ID/secret; products "Share on
  LinkedIn" + "Sign In with LinkedIn using OpenID Connect"): needs a
  LinkedIn Page to attach to. Say which Page, or that I should create
  one for Wren Automation.
- ~~YouTube~~ done 2026-09-20 with jinwilliam.jin@gmail.com (channel
  JinstersJournal): Cloud project `wren-509223`, OAuth client, consent,
  refresh token kept; the Data API answers. Say if another Google account
  owns the channel you want to post to.

## Keys not yet obtained

- `BROWSERBASE_*`: skipped on purpose (no Browserbase).
- htn-2026 demo branch: waits on a spec beyond "config, copy, time
  compression".
