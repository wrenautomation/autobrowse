# 4 · Google OAuth: YouTube and Gmail

**Goal:** YouTube uploads/reads and Gmail reads/sends through official APIs,
consent kept per account, codes readable from any Google inbox.

Both are done today (`site` shows `token ok`). This is how it was done and
how to add another account.

## The OAuth client (once)

```sh
pnpm autobrowse site setup youtube oauth-client
```

A compiled flow on Cloud Console (`google-cloud-project`,
`google-cloud-oauth-client`): a project, the YouTube Data API and Gmail API
enabled, a Desktop OAuth client with redirect `http://127.0.0.1:9400/oauth/callback`,
the id and secret kept as `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`.
The consent screen is External + Testing; add each Google account that will
consent as a test user (**you**, once per account), or the dialog refuses.

## Consent

```sh
pnpm autobrowse site setup youtube consent
pnpm autobrowse site setup gmail consent
pnpm autobrowse site setup gmail consent --account will@x.dev   # another inbox
```

`google/oauth-consent` runs in the logged-in `google` (or `google@<label>`)
profile: chooser, unverified-app warning ("Continue"), scope boxes, until the
loopback redirect. The refresh token is kept under the site (or
`GMAIL_REFRESH_TOKEN__WILL_X_DEV` for a second account) and rolled on use.

## Use

```sh
pnpm autobrowse site call youtube GET "/youtube/v3/channels?part=snippet,statistics&mine=true"
pnpm autobrowse do "upload this to youtube" --input file=talk.mp4 --input title="Talk"   # gated: a publish
pnpm autobrowse site call gmail GET "/gmail/v1/users/me/messages?q=newer_than:1d&maxResults=5"
pnpm autobrowse site call gmail GET "/gmail/v1/users/me/messages?q=newer_than:1d" --account will@x.dev
```

One-time codes and mail sending act as a consented address through its own
token, so any Google inbox works — not only the Workspace domain (the
service account's domain-wide delegation stays the path for those).

## Where it breaks

| Symptom | Fix |
|---|---|
| "Access blocked: app has not completed verification" | add the account as a test user on the consent screen |
| `invalid_grant` on a call | consent again (token revoked or the test-user 7-day expiry hit); `site status gmail` says |
| a route answers `browser` not `api` | the token lacks the scope; consent again grants the current list |
