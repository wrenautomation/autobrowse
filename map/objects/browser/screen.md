---
type: object
cluster: browser
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/browser/screens.ts
---

# Screen

A page a walk knows by its look, with what to do there: `Screen` and `walk()` in `src/browser/screens.ts`. A page learned at run time is a `LearnedScreen` in `screens.json`.

## Why this shape

Sign-ins branch. Determinism is per known screen, not per fixed sequence: a walk observes, acts, waits to leave, and is stuck after three sightings of the same screen in a row (a `repeats` screen on a new URL, a next page, is not). An unknown page is looked up among learned screens, then read once by a model, then fails (`src/browser/screens.ts:329-451`).

## Shape

- `Screen { name, looks, at?, shows?, hides?, says?, is?, act?, goal?, overlay?, repeats? }` — `src/browser/screens.ts:34-57`; `isOn` needs at least one check — `:284`
- `Walk` (screens, `maxSteps` default 12, `fail`) — `:329`; `walk(ctx, w)` — `:418`
- `LearnedScreen { site, url, landmarks, walk?, screen?, click?, reason, found, used }` and `LearnedScreens` store — `:64-94`; file `SCREENS_FILE` = `~/.config/autobrowse/screens.json` (`src/app/config.ts:114`)
- `ScreenReader` (a model names an unknown page) — `:102`, `llmScreenReader` `src/browser/repair.ts:141`
- Walks in force: Google (`src/auth/google.ts`), Cloudflare (`src/auth/sites.ts`); runner interrupts (a cookie banner) share the file

## Connected to

- **owned-by:** a walk ([[site-login]], [[identity-provider]]); the runner for interrupts (`RunnerOptions.learnedScreens`, `src/browser/flow.ts:241`)
- **joins:** [[hints]], [[state-files]]
- **looks-like-but-is-not:** [[fix]] (per op, per flow); `Screen` in `src/app/screen.ts:9` (headed or headless)

## If you change this

- **Hits:** `src/auth/google.ts`, `src/auth/sites.ts` (cloudflare walk), `src/browser/flow.ts` (interrupt lookup), `src/browser/repair.ts:141`, `autobrowse screens` (`src/app/cli-record.ts`), `test/site-fakes.ts`.
- **Does not hit:** compiled workflows and their outline; fixes.

## Surfaces

| Surface | Role |
|---|---|
| walks, runner | read, keep |
| `autobrowse screens` | list, forget |

## See

- Source: `src/browser/screens.ts`
- Design: `designs/2026-09-27-screens.md`
