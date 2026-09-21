# 2 · Sites

**Goal:** call any service under its official API shape; see what each site
can do right now and what setup is left.

## What is there

```sh
pnpm autobrowse site
```

```
linkedin   no token  routes: 8  setup left: developer-app, consent
youtube    token ok  routes: 6  setup left: none
instagram  no token  routes: 8  setup left: developer-app, consent
tiktok     no token  routes: 8  setup left: developer-app, consent
outlook    no token  routes: 7  setup left: app-registration, consent
gmail      token ok  routes: 4  setup left: none
meta       no token  routes: 27  setup left: developer-app, consent
x          no token  routes: 7  setup left: developer-app, consent
```

`site status <site>` is every route with how it answers now: `api` (token in
hand), `browser` (a recorded flow), `none` (why). `!` marks irreversible
routes (a post, a publish) — those are gated.

## One call

Paths are concrete, as the API takes them; the params come off the path.

```sh
pnpm autobrowse site call youtube GET "/youtube/v3/channels?part=snippet,statistics&mine=true"
pnpm autobrowse site call gmail GET "/gmail/v1/users/me/messages?q=newer_than:1d&maxResults=5"
pnpm autobrowse site call gmail GET "/gmail/v1/users/me/messages/<id>?format=metadata"
pnpm autobrowse site call linkedin POST /rest/posts --body '{"author":"urn:li:person:…","commentary":"hi"}'
pnpm autobrowse site call meta GET "/act_123/campaigns"
```

A template path with the id in `--body` does not work (`{id}` goes to the
server literally). Write the id into the path.

## Setup steps

A site lists what makes its token: a developer-app flow on the console
(recorded once, then deterministic) and an OAuth consent (hand-written flow
through the logged-in profile).

```sh
pnpm autobrowse site setup youtube oauth-client     # Cloud Console flow → GOOGLE_OAUTH_CLIENT_ID/SECRET
pnpm autobrowse site setup youtube consent          # consent in the google profile → refresh token kept
pnpm autobrowse site setup gmail consent --account will@x.dev   # another inbox, its own token
```

Keys land in the env store through the same sink `keep` uses. `OAUTH_PORT`
(9400) is the loopback redirect every OAuth client registers.

## Several identities

`--account <address>` on `setup`/`call` picks the `google@<label>` profile
whose credential has that username; the token is kept under its own name
(`GMAIL_REFRESH_TOKEN__WILL_X_DEV`).

## From wren

The same facade is the Restate service `sites` (`sites/call`, `sites/status`,
`sites/setup`). wren's `Content` and `Ads` services call it; a call queues
while the box is down and a write runs once. Design:
`../designs/2026-09-21-site-apis.md`.

## Adding a site

One module in `src/sites/`: a `SiteApi` with routes (`request` schema, `api`
leg, optional `browser` leg, `spends`/`irreversible` marks) and `setup` steps
naming the env names they make. Register it in `src/sites/index.ts`; the
CLI, the UI, `do` and wren see it at once. `src/sites/x.ts` is a small one
to copy.
