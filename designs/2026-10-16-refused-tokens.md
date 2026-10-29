# A refused token is due now

2026-10-16. On 10-15 a one-off script revoked the Wren TikTok app's grant to film the consent
screen. That killed `TIKTOK_REFRESH_TOKEN`. `site check tiktok` said `409 … invalid_grant`, wren
listed it under `missed`, and `site renew` did nothing: it only re-made tokens lapsing within 14
days, and this one lapses next year.

## What happens now

- **Kept.** A refusal (`invalid_grant` on the refresh, a revoke, a 401 or Graph 190 on the
  site's who-am-I probe) is kept by name, site, account, since when, the site's words and a
  short hash of the refused value (`src/sites/refused.ts`, `refused-tokens.json` in the state
  dir). Never a value.
- **Confirmed by the probe.** A 401 or Graph 190 on any other route asks the probe once with
  the same bearer. Refused too: a dead token. The probe answers: the route refused, the error
  stays as it was. A passed probe vouches 10 min.
- **Held.** While the kept value hashes to the refused one, a call throws the 409 with no call
  to the site. A new value (a re-make, a paste) goes through. The 409 carries `need_login`.
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

- 2026-10-29 (WA-976): Graph sends 190 as a 400, so the 401-only probe check missed a dead
  Meta token, the daily probe too. A 190 is not always a dead token: the 170 of 10-14 to 10-22
  were a live user token on a Page-owned read (fixed in ff7c433). So off the probe, the probe
  decides. Rejected: every 190 is a refusal (a re-make cannot fix a wrong-token bug); a hold in
  each wren loop only (every caller would need it).

## Wren

`TokenRenewal/box` calls `sites/renew` every day (was: sleep until the next lapse, 1 to 7 days),
so the probes and the refused re-makes run daily.

A `need_login` refusal holds the read in `holdCap` for an hour (`LOGIN_HOLD_MS`): SocialWatch,
metrics and the posts watch ask again after it, not each pass.
