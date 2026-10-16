# A refused token is due now

2026-10-16. On 10-15 a one-off script revoked the Wren TikTok app's grant to film the consent
screen. That killed `TIKTOK_REFRESH_TOKEN`. `site check tiktok` said `409 … invalid_grant`, wren
listed it under `missed`, and `site renew` did nothing: it only re-made tokens lapsing within 14
days, and this one lapses next year.

## What happens now

- **Kept.** A refusal (`invalid_grant` on the refresh, a revoke, a 401 on the site's who-am-I
  probe) is kept by name, site, account, since when and the site's words
  (`src/sites/refused.ts`, `refused-tokens.json` in the state dir). Never a value.
- **Said once.** The first refusal of an incident is one line in the ops Discord lane
  (`src/app/ops.ts`). Later calls add nothing.
- **Re-made now.** When a `sites`/`desk` call fails 409 on a refusal, the service queues
  `renew {names: [name]}` on itself, one-way, keyed `remake <name> <since>`. One per incident.
- **Daily.** `renew` first runs one probe per site with an API leg, so a dead token nothing
  called is found. Then refused names are due with lapsing ones, placed on the same setup step
  and account.
- **Two days, then stop.** One try a day, marked before the setup runs. A hung consent page
  costs that day, not a loop. After two failed days renew stops and pings once with the setup a
  person runs. A setup that makes the token, or a call that works with it, ends the incident.
- **Our own revokes.** `site revoke <site> [--account] [--after <min>]` is the only way our
  code ends a grant (`OAuthSpec.revoke`; TikTok's `/v2/oauth/revoke/`). It marks every kept name
  the grant covered (the real copy and aliases pointing at it) and queues their re-make in the
  same call. `--after` waits, so a consent screen can be filmed first.
- **Shown.** `site list`, `site status` and `site check` print refused tokens, since when, and
  where the re-make stands. `check` exits 1 while any are open.

## Decisions

- A JSON file on the desk, not Restate state: the CLI and the worker on one Mac read the same
  rows, and `site status` works with Restate down.
- Queue on the 409 in the service, not in the facade: the send must be journaled to be durable.
  A refusal seen by the CLI or HTTP face is still kept and re-made by the next daily renew.
- A busy browser profile reached no site, so its day is given back.
- The access-token cache is keyed by refresh name and value. Before, a re-made refresh token
  could serve the old grant's access token for up to an hour.
- The one-off `revoke-tiktok-once.ts` was never committed to wren; nothing to delete.

## Wren

`TokenRenewal/box` calls `sites/renew` every day (was: sleep until the next lapse, 1 to 7 days),
so the probes and the refused re-makes run daily.
