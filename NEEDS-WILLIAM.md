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
carry. Dated 2026-09-25.

## In order of payoff

0. **Port 25: AWS said no (2026-09-23); RackNerd instead.** A RackNerd KVM
   (port 25 open, rDNS self-serve, ~$11–20/yr) replaces the AWS prober.
   Yours: approve the payment gate, and any ID/phone check RackNerd asks.
   Then: Docker + mailifier on it, rDNS `probe.wrenautomation.com`,
   `WREN_SMTP_PROBE_URL` pointed at it, the AWS prober removed.
1. **Meta: a card on ad account act_1852812755843751**
   (`meta-ad-account-card`). Time zone is America/Toronto (set 2026-09-23),
   CAD. Ads Manager → Billing & payments → Add payment method. Ads that go
   ACTIVE ask you over the channel; `SPEND_*` sets what runs without asking.
   `leads_retrieval` needs app review; a CTA to the lander works without it.
2. **Anthropic credits** ($5) → the agent explores with the good model.

## Cards (2026-09-25)

Wait for the SSM Deny to land first (below). Then copy
`number mm/yy cvc [postal] [name on card]` and run
`pnpm autobrowse wallet add main --kind credit`; the same with
`--kind debit` for the debit card. The clipboard is emptied after.
Debit is used only on hosts you name in `WALLET_DEBIT_HOSTS` (e.g.
`td.com,canada.ca`), never for a subscription.

AWS CLI is signed out and `autobrowse aws-login` hit a 400 twice. Run
`! aws login` once; then I apply the `/wallet` Deny on both boxes.

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

## Wren accounts

Instagram: the website link (wrenautomation.com) is phone-app only; Instagram
web disables the field. Bio and phone later.

X and TikTok: the web signups hit app-only risk walls, headed or not. In
each phone app: sign up → Continue with Google → william@wrenautomation.com,
name "Wren Automation", handle wrenautomation. Then `autobrowse creds made
x@wren` / `creds made tiktok` (`x` is your own X; never Wren's). The
housekeeping after (photo `assets/brand/wren-pfp.png`) is one agent line.

## Not wanted

`BROWSERBASE_*` (no Browserbase). htn-2026 demo branch waits on a spec.


THINGS TO DO:
- make the clicks facade pattern more robust, injecting random mouse movements (does plyarwight support a ltieral cursor dragigng erractically across the screen, i thinkw ee need that)
  — done (afa9a31): tremor, wandering, wheel scrolling; SHOW_POINTER=true draws the cursor
- module separation for this part of the script? (human actions)
  — done: src/browser/human imports nothing from autobrowse (a test holds it)
- bill stuff with my credit card (and save my debit card, but heavily prefer not to use it, especially for any subscription based / online thats not banking / strict)
  — built: `autobrowse wallet`, designs/2026-09-25-wallet.md; see Cards above
- grpc api revamp? discuss after all others are done
