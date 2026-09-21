# Needs William

What autobrowse cannot do for itself. The list itself is code now:

```sh
pnpm autobrowse needs             # every open row: logins, keys, consents, phone, Mac, money, decisions
pnpm autobrowse needs do <id>     # runs the ingestion: creds from the clipboard, a consent, a setup step
pnpm autobrowse needs done <id> --note …   # a decision or a by-hand step you did
pnpm autobrowse accounts          # which of your accounts is for what, and how ready each is
```

Rows clear themselves when the thing is in hand (a credential stored, an
env name set, a token kept). This file only keeps the words the rows cannot
carry. Dated 2026-09-22.

## In order of payoff

1. **`needs do login-facebook`, then `keys-meta`, `consent-meta`, the card**
   → ads run, Page and Instagram post (`walkthrough/03-meta-app.md`).
   The developer app: a Business app on developers.facebook.com with
   Facebook Login for Business, Marketing API and Instagram, redirect
   `http://127.0.0.1:9400/oauth/callback`. Ads that go ACTIVE ask you over
   the channel; `SPEND_*` sets what runs without asking. `leads_retrieval`
   needs app review; a CTA to the lander works without it.
2. **`needs do login-linkedin`** → `site setup linkedin developer-app` is
   recorded with you once (needs a Page: `needs done linkedin-page`), then
   LinkedIn posts go out from the content loop.
3. **A readable inbox for Wren's signups** (`signup-inbox`). The policy says
   `william@wrenautomation.com`; its consent hits Google's passkey challenge
   (the virtual authenticator we enrolled is not the passkey Google wants;
   same wall as admin.google.com), so either you pass that passkey prompt
   once (`site setup gmail consent --account william@wrenautomation.com
   --headed`), or add `gmail.readonly` to the domain-wide delegation
   (admin console → Security → API controls → Domain-wide delegation →
   client `107356403027866983613` → add
   `https://www.googleapis.com/auth/gmail.readonly`, then
   `GOOGLE_WORKSPACE_DOMAIN=wrenautomation.com` in .env), or `creds paste
   google@will` for will@williamjin.dev and `accounts use signup` it.
   Meanwhile `signup <site> --email jinwilliam.jin+wren@gmail.com --inbox
   jinwilliam.jin@gmail.com` works today.
4. **Anthropic credits** ($5) → the agent explores with the good model.
5. **`unsubscribe`** — the list below, ready to paste.

## Accounts (policy, seeded 2026-09-22)

`jinwilliam.jin@gmail.com` = pays (Cloud project `wren-509223`, YouTube
JinstersJournal, developer apps that bill). `william@wrenautomation.com` =
default, signup. `will@williamjin.dev` = personal. Change it with
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
- `youtube-channel-owner`: a channel on a wrenautomation.com Google
  account, not a signup; `google/youtube-channel-create` is the flow to
  record once you say which account. JinstersJournal is jin's.
- `linkedin-page`: the developer app needs a Page; yours, or one for Wren.
- `virtual-cards-vendor`: Privacy.com or your bank; the rest is built like
  passwords (placed, origin-bound to the merchant).

## Wren accounts (`autobrowse signup <site>`)

`signup instagram|x|tiktok --name "Wren Automation" --handle wrenautomation
--headed` mints the password sealed first, fills the form placing
email/password/code/phone by name, and hands you the window at a captcha.
Instagram: make it professional after (Settings → Account type). X: then
`needs do keys-x` (developer.x.com, OAuth 2.0 confidential, read+write,
the redirect above). After each: `creds push <site>` so the box has it.

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
