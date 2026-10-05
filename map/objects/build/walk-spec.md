---
type: object
cluster: build
universe: live
status: verified
verified: 2026-10-05 @ teach-mode
entity: src/walks/spec.ts
---

# Walk (built from runs)

A deterministic flow built from explore runs that reached one goal, or from one chore done by hand (`autobrowse teach`): `WalkSpec` in `src/walks/spec.ts`, saved as `walks/<site>/<name>.json` beside the credentials file, run as the catalog flow `<site>/walk-<name>` by `walkFlow` (`src/walks/flow.ts`).

## Why this shape

Data run by one interpreter, not rendered TypeScript: a walk is rebuilt from new runs with no compile, and `walk()` in [[screen]] already has the look, act, leave loop and the unknown-page ladder. Screens, not a fixed sequence: a screen seen in only some runs is a branch the loop takes when the page is that screen.

## Shape

- `WALK_VERSION` 2; version 1 files still load (v1 runs a field on its example, v2 never does) — `src/walks/spec.ts:24`
- Values (`walkValueSchema`): `plan`, `secret`, `literal`, and `profile` (one of `PROFILE_FIELDS`) — `:34-57`. Fields may carry a `default` (text or `today+Nd`, `RELATIVE_DAY`) and `options` — `:60-67`. `open.url`, click hints and a select value may name `{field}` (`FIELD_REF`, `fieldRefs`; every ref must be a field) — `:70`, `:201`
- `walkOpSchema`: the outline's ops plus `open`, `captcha`, `walk` (nest another walk, `MAX_DEPTH` 4) — `:75`, `:26`
- `screenSpecSchema` (url, up to 12 landmarks, ops, `goal`, `after`, `once`, `seen`) — `:93`; `walkSpecSchema` (fields, secrets by key, `from` runs, `irreversible`) with its checks — `:112-180`
- Store: `saveWalk` (0600) — `:212`; `loadWalk`, `listWalks` read the owner's own, then installed [[mod]]s' (`modWalkDirs`; the owner's wins, a listing carries `mod`) — `:238-277`
- Build: `visitsOf` cuts a run into visits; on a run a person drove (`driver: person`) a load no act led to is an `open` op — `src/walks/build.ts:128`; `walkFromRuns` clusters visits into screens, newest run's ops win, and guesses each typed value's source (secret, profile, same each run = fixed, date = `today+Nd`, else a field defaulting to what was typed; an id seen in an opened URL or a clicked text becomes `{field}`) and returns those `guesses` — `:232`; `buildWalk` picks ended runs (`USABLE`) — `:638-644`
- Teach: `review` walks the guesses one key each (Enter, f, a, p, s), `choose` moves one value, `packInto` writes a [[mod]] and refuses values that look personal (`personalValues`) — `src/walks/teach.ts:58-233`; the command is `src/app/cli-teach.ts`. Explore takes a look once the DOM goes quiet after a hand act (`lookWhenQuiet`) — `src/explore/server.ts:668`
- Run: `walkFlow` (input, then default, then v1 example, then `deps.ask`; profile values through `deps.profile`) — `src/walks/flow.ts:256`; `walkFor` resolves secrets through stored logins (`walkSecrets`) and profile values on the Mac — `src/app/services.ts:641`, `:605`; the Restate `flow` handler falls back to it — `src/engine/browser-service.ts:160`

## Connected to

- **owns:** `walks/<site>/<name>.json`; a [[mod]] may carry one under `mods/<dir>/walks/`
- **owned-by:** the owner's state dir ([[state-files]])
- **joins:** [[explore-run]] (input), [[screen]] (`walk()`, `PageLook`), [[outline]] (op and field schemas), [[flow]] (`FlowPage`), [[browser-service]] (catalog), [[sign-in-context]] (`loginSecrets`)
- **looks-like-but-is-not:** a hand-written sign-in walk (`Walk` in `src/browser/screens.ts`, code); a [[compiled-workflow]] (TypeScript, from one recording)

## If you change this

- **Hits:** [[mod]] (`checkMod`, the scrubber drops examples and personal defaults), `src/walks/build.ts`, `src/walks/flow.ts`, `src/walks/teach.ts`, `src/app/cli-runs.ts` (`walks show` prints value sources), walk files already on disk (`WALK_VERSION`).
- **Does not hit:** compiled workflows; hand-written walks in `src/auth/`.

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse walks build`, `autobrowse teach` | write |
| `walks run`, Restate `browser/flow`, `walks list/show` | read |

## See

- Source: `src/walks/`
- Design: `designs/2026-09-30-runs-and-walks.md`, `designs/2026-10-05-teach-mode.md`
