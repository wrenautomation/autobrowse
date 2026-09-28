# 3 · Meta app: ads, Pages, Instagram

**State 2026-09-23:** app `Wren Automation` (1584158149862012) made on
Wren's Facebook profile, consent done (14 scopes granted), Page `Wren
Automation` reads back (Graph id 1258841687320289), ad account
act_1852812755843751 reads back on prod (`wren ads accounts`). Owed: your
card on it. Instagram `wrenautomation` is linked to the Page (IG business
id 17841426522027395); wren's instagram channel posts over the Graph API.

**Goal:** one Meta token on the box that runs ads (Marketing API), posts to
the Page, and publishes to the Page's Instagram account. Then `wren ads`
and the content loop use it without you.

What only you can do is marked **you**. The rest is `site setup meta …`.

## What you need first

- **you** A Facebook login that admins the Page and the ad account
  (yours, or Wren's — guide 7 makes one). `pnpm autobrowse creds paste facebook`.
- **you** A Business portfolio on business.facebook.com with the Page and an
  ad account that has a payment method. The card is yours to add; the gate
  would stop me at it.
- The Page's Instagram account switched to Professional and linked to the
  Page (Instagram → Settings → Account type; then Page → Settings →
  Linked accounts).

## The app (once)

On developers.facebook.com, as that login:

1. My Apps → Create App → use case **Other** → type **Business** → name
   `Wren Automation`, contact email, the Business portfolio.
2. Use cases: **Create & manage ads**, **Capture & manage ad leads**,
   **Manage everything on your Page**, **Manage messaging & content on
   Instagram**. In each, Customize → Permissions → Add every scope
   `metaOAuth.scopes` names (`src/sites/meta.ts`); a missing one fails the
   consent with "Invalid Scopes: …".
3. App settings → Basic → App domains: `wrenautomation.com`.
4. Facebook Login for Business → Settings → Valid OAuth Redirect URIs:
   `https://wrenautomation.com/oauth/callback`. Meta locks Enforce HTTPS on
   and refuses localhost, so not the http loopback other sites use. Nothing
   serves that URL: the consent's browser answers it and hands back the code.
5. App settings → Basic: the App ID and App Secret (`keep`, never Show +
   screenshot).

`site setup meta developer-app` is this as a recorded flow once
`meta-developer-app` exists (I drive it headed with you the first time:
`pnpm autobrowse agent facebook "make a Business app …" --save
meta-developer-app --headed`). By hand, keep the two values:

```sh
pnpm autobrowse env push META_CLIENT_ID META_CLIENT_SECRET   # after putting them in .env
```

## Consent (once per 60 days)

```sh
pnpm autobrowse site setup meta consent
```

The `facebook/oauth-consent` flow opens the dialog in the facebook profile,
picks the Page and ad account, grants the scopes (`ads_management`,
`pages_manage_posts`, `instagram_content_publish`, `leads_retrieval`, …),
lands on the redirect (answered in the browser), exchanges the code for the 60-day long-lived
token, keeps it as `META_ACCESS_TOKEN`. Run it again when it lapses; the
site's status says so.

```sh
pnpm autobrowse site status meta            # every route api
pnpm autobrowse site call meta GET /me/adaccounts
pnpm autobrowse site call meta GET /me/accounts     # Pages, each with its instagram_business_account
```

## App review

In development mode the app works for the people with a role on it (you).
That covers ads, Page posts and Instagram publishing for Wren's own accounts.
**you** App review is needed for `leads_retrieval` (reading instant-form
leads) and to go Live; until then an ad's CTA links to the lander.

## Then, from wren

```sh
pnpm wren ads accounts
pnpm wren ads interests "shopify"           # interest ids for the spec
pnpm wren ads launch ads/founders.json      # PAUSED, prints the ids
pnpm wren ads start <c> <s> <a> --daily 20  # the one command that spends; the box asks you
pnpm wren ads watch start                   # the daily guard
pnpm wren ads insights --preset last_7d
```

Guide: `../../wren/walkthrough/02-meta-ads.md`. Every ACTIVE write is a
spend on the box: it asks over your channel with the budget, or says yes
alone under `SPEND_*`.

## Where it breaks

| Symptom | Cause | Fix |
|---|---|---|
| `setup consent blocked on META_CLIENT_ID` | app values not in the store | `env push META_CLIENT_ID META_CLIENT_SECRET` |
| consent lands on "URL blocked" | redirect URI missing on the app | step 3 |
| `(#200) … requires ads_management` | consented as a login without the ad account | consent as the admin |
| `no page token: not an admin of this page` | the login has no role on the Page | add it in Business settings |
| `GET /{formId}/leads` 403 | `leads_retrieval` not reviewed | app review |
