---
type: object
cluster: sites
universe: live
status: verified
verified: 2026-10-06 @ 44f9824+
entity: src/sites/types.ts
---

# Site API

A site served under its official API's shape, with the steps that make its keys: `SiteApi` in `src/sites/types.ts`; the list is `SITES` in `src/sites/index.ts:52` (linkedin, youtube, instagram, tiktok, outlook, gmail, langfuse, meta, x, reddit, reddit-public, loom, npm, calcom, web, perplexity, discord, fb-public).

## Why this shape

Callers speak the official REST shape. A route has an `api` leg and, only where the API lacks the call, a `browser` leg (a hand-written flow or a compiled workflow). A route marked `prefer: "browser"` answers from its browser leg even with a token: X bills every API read, so its profile, posts, one-post and search reads run on the signed-in page (`src/browser/flows/x-read.ts`, proven 2026-09-29 as x@wren) in v2's shapes, `since_id` as the cursor. Setup steps make tokens the same way (`src/sites/types.ts:51-106`). `auth: {open: true}` is a keyless site (`web`: search and read, `src/sites/web.ts`), every api leg runs. Reddit refused Wren an API client (2026-09-29), so `src/sites/reddit.ts` is all browser legs in the Data API's shapes, on old.reddit.com (`src/browser/flows/reddit.ts`); they need a home IP, so wren calls them on the Mac's `desk` service ([[app]]). `reddit-public` (2026-10-06) is the same GET routes minus the account's own (`/api/v1/me`, `/message`), plus subreddit search, about and top, run signed out in its own profile: old Reddit sends a signed-out visitor to /login, so its reads pass `signedOut` and the read flow fetches www's `.json` instead (proven from the Mac). A `signedOut` site borrowing another site's flow runs it in its own profile (`src/sites/facade.ts`). Loom has no owner API: `src/sites/loom.ts` reads a video through open oEmbed and uploads, retitles and deletes through the web app (`src/browser/flows/loom.ts`); the upload's share link is the post. Web search (2026-09-29, `designs/2026-09-29-web-search.md`): `web GET /google` reads Google's page in the browser (AI Overview, results, ads, `src/browser/flows/google-search.ts`); `signedOut` runs it in the site's own profile with no account. LinkedIn without LinkedIn (2026-10-03): `web GET /linkedin/profile` and `/linkedin/company` read Exa's cache (`livecrawl: never`) into the `linkedin` site's shapes, `/companies` is Exa's company search by domain, and `/exa/companies?q=` (2026-10-05) lists firms for a niche and city query, 7 mills a search whatever `n` (`src/reach/web.ts`, wren's `exaSearch` pool stage); all Exa routes share the `exa` cap in mills, 330 a day per live key (`capsPerKey`). Exa keys are a ring (`NUM_EXA`, `EXA_API_KEY_1..n`, plain `EXA_API_KEY` first, `src/reach/key-ring.ts`): a key out of credit (402, or a 4xx naming credits) is skipped until the 1st, marked in `spent-keys.json`. Perplexity's `POST /chat/completions` (`src/sites/perplexity.ts`) uses the Sonar key when held, else asks the signed-in web app (`src/browser/flows/perplexity-ask.ts`); `via: "google"` makes its account the one at Google, so the leg runs in that account's Google profile, where the sign-in lives. A browser leg may name a built walk (`<site>/walk-<name>`, [[walk-spec]]): `sitesFor` looks a flow up in the catalog, then in the owner's walks (`src/sites/wire.ts`). `fb-public GET /ads?q=` (2026-10-05, `src/sites/fb-public.ts`) is the walk `fb-public/ad-library` on the Mac: Meta's Ad Library signed out, each ad's advertiser, page, text and unwrapped link; wren's `adLibrary` pool stage calls it on the desk. Its groups routes, also signed out: `GET /groups?q=` runs the `web/google` flow as `site:facebook.com/groups <q>` and groups the results by group (`groupsOf`); `GET /groups/{group}` is the About walk, `GET /groups/{group}/posts/{post}` the post walk with its top comments. `meta GET /instagram/{username}` (2026-10-05, `src/sites/meta.ts`) is Graph's `business_discovery` on Wren's Facebook Login token: a business or creator account's profile and newest 25 posts, `found: false` for an unknown name or a personal account (Graph 110/2207013), a rate-limit code a 429, 300 reads a day.

## Shape

- `SiteApi { site, origin, auth: {token}|{oauth}|{open}, routes, setup, purpose?, probe?, caps?, accountCaps?, pace?, signedOut?, via? }` — `src/sites/types.ts:160-207`; `caps` = most a route's `meter` may use per account per day (LinkedIn: profile 80, search 25, company 40, notifications 12 for `GET /notifications`, the notifications page read only, `src/browser/flows/linkedin-notifications.ts`, 2026-10-06; activity 0 for `GET /in/{vanity}/activity` (`src/sites/linkedin.ts:385`), a member's posts, reposts and comments for wren's signals collector, flow `linkedin/activity` in `src/browser/flows/linkedin-activity.ts`, registered at `src/engine/browser-service.ts:106`, unproven: the first live read as `linkedin@alt` (2026-10-06) found the account signed out, and its sign-in hit LinkedIn's puzzle check, which needs a person; audience 4 for `GET /audience` (`src/sites/linkedin.ts:437`), the account's own followers and connections (`/in/me/`) and Wren's Page's followers, two page loads, flow `linkedin/audience` in `src/browser/flows/linkedin-audience.ts`, registered at `src/engine/browser-service.ts:108`, on demand from wren only, 0 for `linkedin` and `linkedin@alt`, 2026-10-06; X: profile 150, posts 100, search 50); `accountCaps` = one credential's own caps over those (LinkedIn's `linkedin`, William's own profile: profile, search and company 0 until he lifts it, 2026-10-01; `linkedin@alt`, the research alt, reads only: profile 20, search 5, company 10, activity 10, sends 0, `src/sites/linkedin.ts:176`); `pace` = gap between one account's browser calls (X 5s + up to 10s, LinkedIn 10s + up to 20s, Reddit 20s + up to 40s; Reddit caps posts 3, comments 20 a day, attempts included)
- `SiteRoute { method, path ({param}), request (zod), api?, browser?, irreversible?, spends?, meter?, prefer?, summary }` — `:46-76`; `ApiLeg { token, http, env, keep? }` — `:20-27`; `keep` puts a secret a call made (a Discord webhook URL, `src/sites/discord.ts`) in the sink so the answer never carries it; `Leg = {flow}|{workflow}`, `BrowserLeg` — `:32-44`
- `SetupStep { name, makes, needs?, how: Leg+input | {oauth}, summary, purpose? }` — `:86-101`; `OAuthSpec` — `:103-153`; `SiteError { status, retryAfter? }` — `:199-209`
- Per-site files: `src/sites/<site>.ts`; `route()` erases types — `:212`

## Connected to

- **owns:** routes, setup steps, its OAuth spec
- **owned-by:** [[site-facade]]
- **joins:** [[token]] (`auth`, `makes`), [[flow]] / [[compiled-workflow]] (browser legs), [[ability]] (`kind: "site"`), [[need]] (`siteNeeds`), [[account]] (`purpose`), [[spend-policy]] (`spends`)
- **looks-like-but-is-not:** [[site-login]]; `Site` the profile name

## If you change this

- **Hits:** `src/sites/facade.ts`, `src/sites/renew.ts` (`keptBy`), `src/sites/wire.ts`, `src/app/needs.ts:68-184`, `src/do/catalog.ts:83`, `src/app/cli-site.ts`, UI `/api/sites` (`src/ui/api.ts:466-520`), wren's channel packages (they call these routes by path).
- **Does not hit:** sign-ins; the run object.

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse site call/setup/check` | calls |
| wren (Restate `sites`) | calls |

## See

- Source: `src/sites/types.ts`, `src/sites/index.ts`
- Design: `designs/2026-09-21-site-apis.md`
