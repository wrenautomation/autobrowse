# LinkedIn and YouTube posting

2026-09-22. Both were "top priority, API is fine if it works". YouTube now
posts through its API. LinkedIn posts through the composer, and the API
waits on one thing only William can give it.

## What was actually in the way

**LinkedIn** — the account signs in with Google, and that was never the
problem: One Tap was. `accounts.google.com/gsi/button` is a cross-origin
iframe the page's own locators cannot see, and with `auto_select=true` the
card opens *by itself* as a second page before anything is pressed, which
made the button under it unclickable and made `nextPage()` miss the card
it was waiting for. Three changes fix it for every site behind a Google
button, not just LinkedIn:

- a frame hint on the provider's button readings (`locate.ts` already
  takes `frame`),
- `oauthLogin` looks for a provider page that is *already open* before it
  presses anything, and treats a click that failed under an open card as
  success,
- `signInToGoogle` answers the `gsi/select` card directly: pick the
  account if it is still listing them, then `#confirm_yes`. No password —
  the card is a chooser over a live session. Nothing in that branch may
  touch the opener, whose postMessage channel dies on navigation.

`autobrowse login linkedin` now reports `signed in` unattended.

**The LinkedIn API is still walled.** `/oauth/v2/authorization` redirects
to `/uas/login` and asks for an email and password — with a live session,
on a signed-in profile, and with no Google button on that page (probed
twice, 2026-09-22). A `via google` credential cannot answer it. So the
app is built and waiting: **client id 86k5r0t8g79nz0**, verified against
the Wren Automation Page, Share on LinkedIn + Sign In with OpenID Connect
granted, redirect `http://127.0.0.1:9400/oauth/callback`, scopes exactly
`openid profile email w_member_social`. `linkedin-password` is the `needs`
row; the moment a password exists, `site setup linkedin consent` finishes
and the API leg takes over with no other change.

Meanwhile `POST /rest/posts` answers through `linkedin/create-post`: the
composer at `/sharing/compose`. Every class on that page is a build hash,
so the author control is found by shape — the first
`div[role=button][aria-expanded]` (author, then audience, then comments)
— and the flow *picks* the author rather than reading it, which is
idempotent. `LINKEDIN_AUTHOR` names the Page; without it the post is by
the member.

**YouTube** — five sessions read the passkey wall as the blocker. It was
not. The consent failed with *"Access blocked: Wren Automation has not
completed the Google verification process"*: william@wrenautomation.com
was not a test user on the Cloud project's consent screen (`wren-509223`,
Testing, one test user). Adding it took one panel. The consent then ran
clean and `YOUTUBE_REFRESH_TOKEN__WILLIAM_WRENAUTOMATION_COM` is on
channel `UCJvP02ENWoDeOZxec-hoz9Q` — Wren's own. The lesson worth keeping:
*read the refusal*. "Access blocked" and a passkey prompt look alike from
a distance and have nothing to do with each other.

## Where to attack next

1. **The LinkedIn password.** One `needs` row stands between the composer
   and the API. Everything else is built.
2. **Prove the composer once.** `linkedin/create-post` is written and
   unit-tested; it has never run against the real page, because the first
   run publishes. It needs William's content, not another dry run.
3. **`authorOf` is gone on purpose.** If LinkedIn ever ships a stable
   `aria-label` on the author control, prefer it over the positional
   `div[role=button][aria-expanded]`.
4. **Test users are a class of failure.** Every Google OAuth consent for a
   new address on a Testing project will fail the same way. The
   `google-cloud-oauth-client` workflow has a `test-user` step; the setup
   path should run it for the address being consented, not once at
   creation.
5. **The privacy page.** `wrenautomation.com/privacy` was written for
   LinkedIn's app form but describes the real site — form rows, anonymous
   page views, the open pixel in cold email. It has to change when
   `functions/api` or `hit.ts` does.

## Also noticed

The Cloud console shows *"A potential violation of our Acceptable Use
Policy has been detected for multiple projects you own"* on the account
that holds `wren-509223`. Nothing is blocked today. Worth reading before
it is.
