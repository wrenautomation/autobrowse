# Site APIs: call, set up, check

Each site speaks its own official API's shape. Behind one route the API answers
when a token is in hand, a browser flow otherwise. The caller never knows which.

```sh
pnpm -s autobrowse site                          # sites, token state, setup left
pnpm -s autobrowse site status <site>            # every route: api | browser | none (why)
pnpm -s autobrowse site route <site> <METHOD> <path> [--template]   # one route's inputs; a body file to fill
pnpm -s autobrowse site call <site> <METHOD> <path> [--body <json|file>] [--account <address>]
pnpm -s autobrowse site check [site]             # one who-am-I call per site: is each token alive
pnpm -s autobrowse site setup <site> <step> [--account <address>]   # oauth-client, consent, …: mints and keeps a token
pnpm -s autobrowse site renew [--dry]            # refresh what is due
```

- Put ids in the path: `/company/acme`, never `/company/{handle}` with the id in
  `--body`. A template path is a 400.
- `--body` is the body for writes and the query for reads.
- The account: `--account`, else the one the accounts policy names for the
  site's purpose. A site made through a provider (TikTok via Google) runs its
  browser legs and its consent in that account's provider profile.
- A route that `spends` (an ad set to ACTIVE) goes through the payment gate first.
- Writes that publish (a post, an upload, a comment, a mail) are final: William's
  yes first, every time. `site check <site>` says whose token it is; check it
  before the first write.
- A missing token is an error naming the setup step. Run that step; a consent
  opens a browser in the signed-in profile.
- Keys and tokens land in the env store (accounts.md), never in your output.

Same facade elsewhere: `/api/sites/<site>/<path>` over HTTP, Restate service
`sites` (`call`, `status`, `setup`, `renew`) for wren. Legs a site refuses from
the box's IP run on the Mac's desk (`desk/call`).

Something may already do the whole job: `pnpm -s autobrowse do "<goal>" --dry-run`
says what would run.
