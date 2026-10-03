---
type: object
cluster: build
universe: live
status: verified
verified: 2026-09-30 @ runs-and-walks
entity: src/walks/spec.ts
---

# Walk (built from runs)

A deterministic flow built from explore runs that reached one goal: `WalkSpec` in `src/walks/spec.ts`, saved as `walks/<site>/<name>.json` beside the credentials file, run as the catalog flow `<site>/walk-<name>` by `walkFlow` (`src/walks/flow.ts`).

## Why this shape

Data run by one interpreter, not rendered TypeScript: a walk is rebuilt from new runs with no compile, and `walk()` in [[screen]] already has the look, act, leave loop and the unknown-page ladder. Screens, not a fixed sequence: a screen seen in only some runs is a branch the loop takes when the page is that screen.

## Shape

- `walkOpSchema`: the outline's ops plus `open`, `captcha`, `walk` (nest another walk, `MAX_DEPTH` 4) — `src/walks/spec.ts:33`, `:25`
- `screenSpecSchema` (url, up to 12 landmarks, ops, `goal`, `after`, `once`, `seen`) — `:46`; `walkSpecSchema` (fields, secrets by key, `from` runs, `irreversible`) with its checks — `:65-124`
- Store: `saveWalk` (0600), `loadWalk`, `listWalks` — `:136-185`
- Build: `visitsOf` cuts a run into visits — `src/walks/build.ts:103`; `walkFromRuns` clusters visits into screens, newest run's ops win — `:190`; `buildWalk` picks ended runs (`USABLE`) — `:487-493`
- Run: `walkFlow` — `src/walks/flow.ts:195`; `walkFor` resolves secrets through stored logins (`walkSecrets`) — `src/app/services.ts:567`, `:561`; the Restate `flow` handler falls back to it — `src/engine/browser-service.ts:155`

## Connected to

- **owns:** `walks/<site>/<name>.json`
- **owned-by:** the owner's state dir ([[state-files]])
- **joins:** [[explore-run]] (input), [[screen]] (`walk()`, `PageLook`), [[outline]] (op and field schemas), [[flow]] (`FlowPage`), [[browser-service]] (catalog), [[sign-in-context]] (`loginSecrets`)
- **looks-like-but-is-not:** a hand-written sign-in walk (`Walk` in `src/browser/screens.ts`, code); a [[compiled-workflow]] (TypeScript, from one recording)

## If you change this

- **Hits:** `src/walks/build.ts`, `src/walks/flow.ts`, `src/app/cli-runs.ts` (`walks show` prints op shapes), walk files already on disk (`WALK_VERSION`).
- **Does not hit:** compiled workflows; hand-written walks in `src/auth/`.

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse walks build` | writes |
| `walks run`, Restate `browser/flow`, `walks list/show` | read |

## See

- Source: `src/walks/`
- Design: `designs/2026-09-30-runs-and-walks.md`
