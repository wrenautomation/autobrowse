---
type: object
cluster: browser
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/browser/human/index.ts
---

# Hands

How a person's hands would do each act, in one facade: `Hands` from `handsFor(pace)` in `src/browser/human/index.ts`.

## Why this shape

Robustness lives in one place: a pause to read, a curved reach, typing in runs with mistypes. `pace: null` is instant (tests, the explore console). Nothing else adds delays.

## Shape

- `Pace` — `src/browser/human/index.ts:50`; `Hands { think, click, type, press … }` — `:113`; `handsFor` — `:240`
- Mouse, scroll, typing styles in the sibling files
- Chosen from settings: `paceFor` — `src/app/services.ts:613`

## Connected to

- **owned-by:** the runner (`RunnerOptions.pace`, `src/browser/flow.ts:214`)
- **joins:** [[flow]], the captcha solver (`src/browser/captcha/index.ts:152`), the explore session

## If you change this

- **Hits:** `src/browser/flow.ts`, `src/browser/captcha/index.ts`, `src/explore/server.ts` (pace option).
- **Does not hit:** the desktop leg (`src/desktop/mac.ts`), locators.

## Surfaces

| Surface | Role |
|---|---|
| runner, explore, agent | use |

## See

- Source: `src/browser/human/index.ts`
