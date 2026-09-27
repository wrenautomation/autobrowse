# Needs William

Live list: `pnpm autobrowse needs`. Rows clear themselves. Dated 2026-09-27.

## To do

- **Meta ad card.** Ads Manager → Billing → add a card on act_1852812755843751
  (CAD, Toronto). Then `autobrowse needs done meta-ad-account-card`.
- **TikTok.** In the phone app: sign up → Continue with Google →
  william@wrenautomation.com, name "Wren Automation", handle wrenautomation.
  Then tell me. I do the developer app and consent.

Optional: `autobrowse creds paste google@will` and a Gmail consent for
will@williamjin.dev, if autobrowse should read that inbox.

To skip a text for a purchase you already said yes to:
`autobrowse spend --grant <site> --hours 2 --note "<who said so>"`.

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

- **Self-healing flows?** Yes, three layers, cheapest first.
  - A moved button: the fix found once is kept (`autobrowse repairs`) and
    tried first next run. No 15s wait, no model.
  - No kept fix: one model call on a page snapshot finds the control.
  - A compiled workflow step that still fails: `AUTO_HEAL=true` rewrites
    only that step and proves it again. Off by default.
  - To audit: `WATCH_FLOWS=<site>` records each step (masked shot, page
    tree, trace); `autobrowse watched` reads it.

## Done since last list

RackNerd paid (09-25). Anthropic credits. X live, named "Wren Automation".
Cloudflare: ••4445 is the primary card; wrenautomationreviews.com bought
(09-27, $10.46, auto-renew off). Twilio number skipped. Outlook deferred.
Virtual cards: not needed, the wallet has both cards.
