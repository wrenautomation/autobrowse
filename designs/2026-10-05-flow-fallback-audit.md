# Flow fallback audit

2026-10-05. Status: built. Spec: `2026-09-27-screens.md`, `2026-09-30-runs-and-walks.md`.

## Ask

William: workflows must expect UIs that keep changing (Cloudflare's
"Continue as", Base UI comboboxes, banners, Turnstile). Branch and fall back
inside the flow, and survive crashes on Restate.

Every flow, browser flow and walk in `src/` was checked against two questions:

1. **Inside:** does each page-dependent step go through a screen, a walk or
   interrupts? Or does it assume one page shape?
2. **On Restate:** is each irreversible or paid step journaled and keyed,
   and is each wait durable? Does a crash, a sleeping Mac or a lost
   connection resume without a second send, post, signup or payment?

## Findings

| Flow | Gap | Fix | Done |
|---|---|---|---|
| `sites`/`desk`/`do` services (Reddit, Instagram, LinkedIn and npm legs, `do` goals) | Not run under `withCall`, so the done-acts ledger was off. If Restate reran a leg after a crash, the post could go out twice. | `withCall(<invocation id> <step>)` around each `ctx.run` body (call, status, setup, renew, do). | Done. Test: `sites-service.test.ts`. |
| Every flow's `fp.has(h, ms)` guard ("dialog opened, else a person") | A plain visibility wait, so a banner or a learned screen in the way meant a false "no". Only `fp.act` cleared interrupts. | A wait now runs the same `clearWay` loop an act does. | Done. Test: `screens.test.ts`, "a wait for a control gets past a learned screen". |
| OAuth consent, shared (`consentFlow`: X, LinkedIn, Instagram, TikTok, Facebook, Outlook) | The allow-button check did not clear interrupts. Unknown pages spin through the rounds, then go to a person. | The check is a wait, so interrupts clear (the fix above). | Done. Not made a walk: Facebook shows several allow pages in a row, likely on one URL, and the walk's stuck rule (the same screen three times on one URL) would stop it. Can't be proven without a live grant. |
| Google OAuth consent (`oauth-consent.ts`) | A round loop. No learned or reader ladder for an unknown page. | None. | Left. Its "Continue" pages repeat on one URL, so the same stuck rule applies. Its branches (chooser, unverified app, re-verify, scopes) are coded, and acts clear interrupts. |
| Form sign-ins (`formLogin`: Instantly, npm, Discord, Reddit, data logins in mods) | Linear: chooser, username, next, password, captcha, code, in one fixed order. A remembered username or a reordered page failed. | A walk built from the same spec, with screens for signed in, captcha, rejected, passkey, each code step, saved accounts, login form, username page and password page. The password is typed once (the previous one once more after a rejection). If the form comes back with no known message, that is a failure, never a retype. | Done. Test: `auth.test.ts`, "a remembered user opens on the password". |
| Microsoft sign-in (`microsoft.ts`) | Linear; screens.md named it the next walk. A passwordless prompt ("Approve sign in request") went to the phone, so a person, even with a password stored. | A walk with 11 screens. New: "Use your password" is taken before the phone, since it needs no person. | Done. Tests: `microsoft.test.ts`, `outlook.test.ts` ("a passwordless prompt takes the password instead"). |
| GitHub, X, LinkedIn, Instagram, TikTok, Facebook sign-ins | Linear if-chains. | None. | Left, per screens.md ("convert as they break"). Acts and now waits clear interrupts, and a failure is `LoginFailed`, so the next method runs. Proving a rewrite means live sign-ins, which trip site security. LinkedIn personal is paused. |
| Cloudflare and Google sign-ins | None. Both are walks; "Continue as" is a screen. | None. | Already done. |
| AWS port 25 request | Submit not marked irreversible. A rerun would file a second request. | Marked. | Done. Test: `irreversible-acts.test.ts`. |
| Google Admin DKIM generate | Raw `page` clicks, so no interrupts and no repair. "Generate" rotates the key and was unmarked (it is guarded by reading the key first). | Through `fp.act`/`fp.has`; Generate marked irreversible. | Done. Test: `irreversible-acts.test.ts`. |
| Cloudflare API token | None. Base UI comboboxes were remapped 2026-09-28; every step goes through `fp.act`; Create Token is marked; bootstrap verifies an existing token before minting. | None. | Fine. |
| Discord bot token | "Create the application" is unmarked, so a rerun makes a second app. | None. | Left. A duplicate app is cheap to delete, and a mark would stop self-repair on that button. The token reset is marked. |
| Posting flows (Reddit submit, comment and message; Instagram Share; LinkedIn and YouTube posts; LinkedIn reach invite and message; Loom delete; npm org, token and trusted publisher; Cal.com key) | None. The final commit is marked. | None. Through `do`/`sites`, the ledger is now on (first row). | Fine. |
| Compiled workflows (anthropic, google-cloud-*, instagram-*, signup-*, langfuse, workspace-skip-passwords, google-name) | None. Commits are marked; renames are idempotent. | None. | Fine. |
| Engine workflows (domain, inbox-fleet, bootstrap, workspace-inbox, redirect, inbox-activity, sender-domain) | None. Each step is `fx.run` (journaled under `withCall`) and reads before it writes (registration-so-far, owned check). The Inbox Insiders order sends an `idempotency_key`, purchases are gated, and waits are `fx.sleep`. | None. | Fine. |
| Built walks (`walks/flow.ts`) | None. A recorded op keeps its irreversible mark; secrets and captcha go through `fp`. | None. | Fine. |
| Unsubscribe chore | None. Pressing a confirm twice is harmless. | None. | Fine. |

## Decisions

- One mechanism. Waits reuse `clearWay`; sign-ins reuse `walk()`. Nothing new.
- A walk only where the page order branches. A consent that repeats one
  screen on one URL stays a loop until the stuck rule can tell pages apart
  (by look, not name and URL).
- `fakeSite` records the goals of acts marked irreversible (`marked`), so
  a missing mark fails a test.
