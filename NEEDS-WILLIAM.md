# Needs William

Live list: `pnpm autobrowse needs`. Rows clear themselves. Dated 2026-09-27.

## To do

- **Cloudflare card.** Say go, then reply yes to the text. I add ••4445 and buy
  wrenautomationreviews.com. My last two texts got no reply.
- **Meta ad card.** Ads Manager → Billing → add a card on act_1852812755843751
  (CAD, Toronto). Then `autobrowse needs done meta-ad-account-card`.
- **TikTok.** In the phone app: sign up → Continue with Google →
  william@wrenautomation.com, name "Wren Automation", handle wrenautomation.
  Then tell me. I do the developer app and consent.
- **Outlook.** `autobrowse creds paste microsoft` with the Microsoft login,
  or say skip. I do the app and consent.
- **X name.** @wren_automation shows "William Jin". Say if it should be "Wren
  Automation".
- **Virtual cards.** Pick Privacy.com or your bank:
  `autobrowse needs done virtual-cards-vendor --note <vendor>`.

Optional: `autobrowse creds paste google@will` and a Gmail consent for
will@williamjin.dev, if autobrowse should read that inbox.

## Your questions

- **gRPC or GraphQL?** No. Each site mirrors the vendor's own REST API. There
  is one client per call, and TS + zod already give types end to end. Worth
  it only if a hot internal path shows up.
- **WebSockets, req/res, or AMQP?** Req/res on Restate. Restate already does
  what AMQP would: durable queues, retries, waiting on a reply. The UI polls.
  If a live view gets slow, add SSE, not WebSockets.
- **Parameters like token name and permissions?** Yes.
  - Workflows take a plan:
    `autobrowse run bootstrap cf --plan '{"provider":"cloudflare","tokenName":"ci","permissions":[{"scope":"Zone","name":"DNS","level":"Read"}]}'`
  - Setup steps take `--input`, merged over the defaults:
    `autobrowse site setup npm token --input '{"name":"ci","expiresDays":30}'`
- **Read the parameters?** Yes.
  - `autobrowse workflows bootstrap`: each input, its type and default.
  - `autobrowse site status npm`: each setup step's input.
  - `autobrowse site route <site> <method> <path>`: a route's fields.
- **Compile time?** `compile` itself is quick. `finish` is the slow part.
  Each round is a model writing the module, then a full typecheck and the
  test. The typecheck is now incremental (15s → 7s from round 2). The model's
  time is most of the rest, and it is only cut by a faster model.

## Done since last list

RackNerd paid (09-25). Anthropic credits. X live (app, tokens, both accounts).
Twilio number skipped.
