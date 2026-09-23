# Needs William

What autobrowse cannot do for itself. The list itself is code now:

```sh
pnpm autobrowse needs             # every open row: logins, keys, consents, phone, Mac, money, decisions
pnpm autobrowse needs do <id>     # runs the ingestion: creds from the clipboard, a consent, a setup step
pnpm autobrowse needs done <id> --note …   # a decision or a by-hand step you did
pnpm autobrowse accounts          # which of your accounts is for what, and how ready each is
```

The UI has the same: **Needs** (done button, a note) and **Accounts**
("Which account for what" at the top).

Rows clear themselves when the thing is in hand (a credential stored, an
env name set, a token kept). This file only keeps the words the rows cannot
carry. Dated 2026-09-23.

## In order of payoff

0. **AWS port 25 — submitted, unconfirmed; watch the pays inbox** (approved
   by you 2026-09-22). The "remove email sending limitations" form for
   `34.233.233.146` (wren-prod-pg, rDNS `probe.wrenautomation.com`) was sent
   through its `send` gate and the page answered with its own confirmation
   text — but no case shows in Support Center (Basic plan files these
   outside it) and no AWS mail has arrived in the pays inbox yet. Nothing
   more to do until a reply lands; if none does in a few days, refile.
   Rerun anywhere: `pnpm autobrowse run aws-port25-request <key> --plan
   '{"contactEmail":…,"elasticIpAddress":…,"reverseDnsRecord":…,"useCaseDescription":…}'`.
1. **Meta: a card on ad account act_1852812755843751**
   (`meta-ad-account-card`). Time zone is America/Toronto (set 2026-09-23),
   CAD. Ads Manager → Billing & payments → Add payment method. Ads that go
   ACTIVE ask you over the channel; `SPEND_*` sets what runs without asking.
   `leads_retrieval` needs app review; a CTA to the lander works without it.
2. **Anthropic credits** ($5) → the agent explores with the good model.

## Accounts (policy, seeded 2026-09-22)

`jinwilliam.jin@gmail.com` = pays (Cloud project `wren-509223`, YouTube
JinstersJournal, developer apps that bill; your own Instagram/X/LinkedIn
are on it). `william@wrenautomation.com` = default, signup: Wren's
Instagram, X, TikTok, YouTube, LinkedIn. `will@williamjin.dev` = personal. Change it with
`accounts use <purpose> <address>`; `accounts push` sends it to the box.

## Phone

Works. `PHONE_NUMBER` is your iPhone. Twilio's own number
(`twilio-number`) is only for running without this Mac.

## Decisions (`needs done <id> --note …`)

- `linkedin-page`: the developer app needs a Page; yours, or one for Wren.
- `virtual-cards-vendor`: Privacy.com or your bank; the rest is built like
  passwords (placed, origin-bound to the merchant).

## Wren accounts (`autobrowse signup <site>`)

Instagram: left for you are bio, link, phone.

`signup x|tiktok --name "Wren Automation" --handle wrenautomation --headed`
mints the password sealed first, fills the form placing
email/password/code/phone by name, and hands you the window at a check.
X: email signup is refused and the phone dialog loops headless, so run it
headed and pass the check yourself; then `needs do keys-x`. After each:
`creds push <site>`; finished one by hand → `creds made <site>`. Then the
housekeeping (name "Wren Automation", photo `assets/brand/wren-pfp.png`)
is one agent line (`walkthrough/07-accounts.md`); bios, links and stories
are yours.

## Not wanted

`BROWSERBASE_*` (no Browserbase). htn-2026 demo branch waits on a spec.
