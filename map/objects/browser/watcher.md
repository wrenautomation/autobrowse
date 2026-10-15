---
type: object
cluster: browser
universe: live
status: verified
verified: 2026-10-15 @ 807dbb0
entity: src/browser/watchers.ts
---

# Watcher (tab watcher)

A fake webhook: one extra tab per watched account sits on a light page, and a rise in the unread count in its title sends the lease's sink. `Watchers` in `src/browser/watchers.ts:115`.

## Why this shape

LinkedIn, X and Instagram push nothing we can use without a review or credits (wren designs/2026-10-12-push-everywhere.md). The site's own live channel already updates the open tab's title; reading it is a local CDP call, so the site sees one open tab and no request from us. Title counts, not per-site selectors or socket frames: one regex across sites, and a title with no count shows in the state, so a stale spec is seen (designs/2026-10-12-watchers-and-arming.md).

## Shape

- `WatchSpec { url, title }`, `WATCH_SPECS` (linkedin saved posts, x bookmarks, facebook home, instagram home: pages that mark nothing read) — `src/browser/watchers.ts:22-41`
- `watchLease { site, account?, sink: {path: ".../send", body}, until }`; id = the account (profile) — `:43-58`; at most a day out
- `lease` (`:149`): adopt or renew, write `watchers.json`, open the tab through `FlowRunner.tab` (`src/browser/flow.ts:425`)
- `check` (`:278`) every 20 s: `page.title()`; first read counts what is unread, after that only a rise; `rise` (`:300`) sends at most once per 30 s, body plus `kind: "activity"`, idempotency key `watch-<id>-<ms>`
- `alive` beat every 10 min while signed in (on the spec's page, no sign-in title): the caller polls less while it hears them
- Tab: images, media, fonts aborted (never in the person's own browser); reloaded every 3 h; a closed tab reopens after 1 min, doubling to 30
- Profile busy (an explore session holds it): `paused` in the state, never closed; looks again every minute, no doubling, and opens once the profile frees (`paused`, `src/browser/watchers.ts:289`); logs `watch paused` / `watch resumed`
- The browser stays open: `SessionPark.pin` (`src/browser/park.ts:67`), counted; `unpin` lets it idle out
- Built on the desk only: `watchersFor` (`src/app/services.ts:615`), sink = POST to `RESTATE_INGRESS_URL`; handlers `desk/watch|unwatch|watches` (`src/sites/service.ts:142`)

## Connected to

- **owned-by:** the desk (`src/app/desk.ts`)
- **joins:** [[session]] (its tab lives in the account's browser, pinned in the park), [[flow]] (flows on the profile queue and run beside it)
- **looks-like-but-is-not:** [[watch-step]] (`WATCH_FLOWS`: screenshots of a flow's steps)

## If you change this

- **Hits:** `src/browser/park.ts` (pins), `src/browser/flow.ts` (`tab`), `src/sites/service.ts`, `src/app/desk.ts`; wren's `SocialPush/watch` reads the sink body.
- **Does not hit:** site routes, the facade.

## Surfaces

| Surface | Role |
|---|---|
| `desk/watch` | lease or renew |
| `desk/unwatch`, `desk/watches` | end one, list states |

## See

- Source: `src/browser/watchers.ts`; tests `test/watchers.test.ts`
