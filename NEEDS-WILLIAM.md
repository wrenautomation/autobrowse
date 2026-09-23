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
carry. Dated 2026-09-22.

## In order of payoff

0. **AWS port 25 — submitted, unconfirmed; watch the pays inbox** (approved
   by you 2026-09-22). The "remove email sending limitations" form for
   `34.233.233.146` (wren-prod-pg, rDNS `probe.wrenautomation.com`) was sent
   through its `send` gate and the page answered with its own confirmation
   text — but no case shows in Support Center (Basic plan files these
   outside it) and no AWS mail has arrived in the pays inbox yet. Nothing
   more to do until a reply lands; if none does in a few days, refile.
   rDNS is done and needs nothing from you: `probe.wrenautomation.com.` is
   the EIP's PtrRecord (set with `aws ec2 modify-address-attribute`, not the
   form) and resolves. Rerun anywhere: `pnpm autobrowse run aws-port25-request <key> --plan
   '{"contactEmail":…,"elasticIpAddress":…,"reverseDnsRecord":…,"useCaseDescription":…}'`.
   The Mac's AWS CLI session is no longer yours to renew: `pnpm autobrowse
   aws-login --user william --overwrite` does it (default profile now = IAM
   user william, admin; root-only work still needs you).
1. **Meta: the card, then the Instagram link.** Done 2026-09-23: Wren's
   Facebook, the Page, the app, the token (14 scopes), ad account
   act_1852812755843751 (named "William Jin", CAD, America/Dawson: rename or
   change if you want). Yours: a card on it (`meta-ad-account-card`), and the
   captcha Instagram shows when the Page links it (`instagram-page-link`).
   Ads that go ACTIVE ask you over the channel; `SPEND_*` sets what runs
   without asking. `leads_retrieval` needs app review; a CTA to the lander
   works without it.
2. **`needs do login-linkedin`** → `site setup linkedin developer-app` is
   recorded with you once (needs a Page: `needs done linkedin-page`), then
   LinkedIn posts go out from the content loop.
3. ~~A readable inbox for Wren's signups~~ done 2026-09-22: the sender
   service account is delegated `gmail.modify`, which reads too, so
   `GOOGLE_WORKSPACE_DOMAIN=wrenautomation.com` makes every wrenautomation.com
   inbox readable (no consent, no passkey). Wren's socials live on
   `william@wrenautomation.com`; your own stay on jinwilliam.jin@gmail.com.
4. **Anthropic credits** ($5) → the agent explores with the good model.
5. **`unsubscribe`** — the list below, ready to paste.
## Accounts (policy, seeded 2026-09-22)

`jinwilliam.jin@gmail.com` = pays (Cloud project `wren-509223`, YouTube
JinstersJournal, developer apps that bill; your own Instagram/X/LinkedIn
are on it). `william@wrenautomation.com` = default, signup: Wren's
Instagram, X, TikTok, YouTube, LinkedIn. `will@williamjin.dev` = personal. Change it with
`accounts use <purpose> <address>`; `accounts push` sends it to the box.

## Phone

Works. `PHONE_NUMBER` is your iPhone; SMS forwarding delivers (short-code
texts landed 2026-09-20 16:45–17:04, so Twilio's MFA texts came ~16 min
late, after the 90 s code wait; a retry passes). Twilio's own number
(`twilio-number`) is only for running without this Mac.

## Decisions (`needs done <id> --note …`)

- `facebook-page-owner`: Pages hang off a personal profile. Your profile
  makes a "Wren Automation" Page (one click, I drive it headed), or a new
  profile for Wren (Meta may ask for ID).
- Wren's YouTube channel is **made**: "Wren Automation"
  (`UCJvP02ENWoDeOZxec-hoz9Q`) on william@wrenautomation.com, created
  2026-09-22 from the signed-in google-admin profile. What is left is the
  API token: the stored one is still JinstersJournal's (yours), and the
  OAuth consent as william@ hits Google's passkey wall (`challenge/pk`).
  Until a matching token exists, **every YouTube write is refused** —
  `YOUTUBE_CHANNEL_ID` is set to Wren's channel and the site checks the
  token's own channel before uploading, commenting or posting. If the
  passkey wall is real and tried four ways (2026-09-22): the OAuth consent,
  the admin-console setting flow, `enroll-passkey`, and the passkeys page
  itself all land on "Use your passkey to confirm it's really you", and
  "More ways to verify" lists **only** the passkey — no TOTP, no recovery
  phone or email. Google holds a passkey we do not have. So, once:
  `autobrowse login google-admin --headed`, pass the prompt on your device,
  leave the window; then everything else is automatic (we enroll our own
  passkey from that session, take the consent, and the channel guard opens).
  Community posts already work through the browser in that profile.
- `linkedin-page`: the developer app needs a Page; yours, or one for Wren.
- `virtual-cards-vendor`: Privacy.com or your bank; the rest is built like
  passwords (placed, origin-bound to the merchant).

## Wren accounts (`autobrowse signup <site>`)

Instagram `wrenautomation` exists on william@wrenautomation.com (made
2026-09-22, Business account, category Marketing Agency, name + Wren mark
set; credential sealed + pushed). Left for you: bio, link, phone. Nothing
else until the Meta app (`keys-meta`).

`signup x|tiktok --name "Wren Automation" --handle wrenautomation --headed`
mints the password sealed first, fills the form placing
email/password/code/phone by name, and hands you the window at a check.
X: email signup is refused and the phone dialog loops headless, so run it
headed and pass the check yourself; then `needs do keys-x` (developer.x.com,
OAuth 2.0 confidential, read+write, the redirect above). After each:
`creds push <site>`; finished one by hand → `creds made <site>`. Then the
housekeeping (name "Wren Automation", photo `assets/brand/wren-pfp.png`)
is one agent line (`walkthrough/07-accounts.md`); bios, links and stories
are yours.

## This Mac (once)

`autobrowse desktop setup`: Accessibility for the terminal app, and the
root helper (three commands, your sudo password; never seen by the agent).

## Unsubscribe (asked 2026-09-22; nothing leaves until `--yes`)

Ran the list 2026-09-22 (45 days): 63 senders. The fleet-work noise
(banks, Google, Instagram, LinkedIn, Claude/OpenAI and the newsletters you
read are not in it):

  ```sh
  pnpm autobrowse unsubscribe --days 45 --yes --only donotreply@e.godaddy.com,support@apollo.io,hello@mail.apollo.io,welcome@supabase.com,tidbcloud-team@pingcap.com,pingcapevent@pingcap.com,tidbscaile@pingcap.com,info@cerebras.net,welcome@cerebras.ai,forward@updates.resend.com,marc@updates.langfuse.com,agno@hello.agno.com,hello@inceptionlabs.ai,devx@backboard.io,team@ship.emergent.sh,team@m.ngrok.com,hi@creativefabrica.com,darlyze@devpost.com,akatos@user.luma-mail.com,thebarn@user.luma-mail.com,socratica@user.wygo-mail.com,hello@m.fontawesome.com,news@nvidia.com,marketing@plans.eventbrite.com,hello@newsletter.life360.com,vsco@customer.vsco.co,no-reply@jm.indeed.com,noreply@qualtrics-research.com
  ```

Then `needs done unsubscribe`.

## Not wanted

`BROWSERBASE_*` (no Browserbase). htn-2026 demo branch waits on a spec.
