---
type: object
cluster: auth
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/app/needs.ts
---

# Need

One thing only the person can give, with the check that clears it: `Need` in `src/app/needs.ts`; `autobrowse needs`. The list with done-marks is `Owed` (`src/app/owed.ts`). `NEEDS-WILLIAM.md` at the repo root is the same list kept by hand for him.

## Why this shape

The owed list clears itself: a credential present, a token kept, a consent done, a phone paired passes its `check`; a decision is marked done by hand (`needs-done.json`).

## Shape

- `NeedKind = credential | keys | consent | phone | mac | money | decision`; `Need { id, kind, what, unlocks, how[], after?, check? }` — `src/app/needs.ts:25-40`
- Sources: `siteNeeds`, `accountNeeds`, `fixedNeeds`, `signupNeeds` → `allNeeds` — `:82-430`; `NeedsContext` — `:42-57`
- Done store: `DONE_FILE` `~/.config/autobrowse/needs-done.json` — `src/app/owed.ts:79`; `Owed`, `Policy` — `:30-46`

## Connected to

- **owned-by:** [[backend]] (`owed`, `policy`)
- **joins:** [[site-api]] (setup steps), [[site-login]], [[account]], [[credential]], [[token]] (`kept` with expiry)
- **looks-like-but-is-not:** an engine [[gate]]; `NEEDS-WILLIAM.md` (prose, not read by code)

## If you change this

- **Hits:** `src/app/owed.ts`, `src/app/cli-needs.ts`, UI `/api/needs` (`src/ui/api.ts:264-287`), `src/app/status.ts`.
- **Does not hit:** the run object; the facade's own token checks.

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse needs`, UI Needs | read, mark done |

## See

- Source: `src/app/needs.ts`, `src/app/owed.ts`
