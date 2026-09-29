---
type: object
cluster: browser
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/recorder/types.ts
---

# Hints

How a control is named everywhere: `LocatorHints` in `src/recorder/types.ts`, `Hints` (any subset) in `src/browser/locate.ts`.

## Why this shape

One vocabulary is captured by the recorder, kept in outlines, typed in flows, proposed by the repairer, stored in fixes and screens. A locator is planned from hints (`planLocator`) and applied to a page or frame; nothing else names a control.

## Shape

- Fields: `tag, role, name, text, placeholder, id, testId, href, inputType`; last resorts `css`, `nth`; `frame` for a cross-origin iframe — `src/recorder/types.ts:9-41`; explore fills a missing `frame` from the visible iframes (`withFrame`, `src/browser/frames.ts`)
- `planLocator(h) → LocatorPlan | null`; `locate`, `locateAll`, `renderLocator` — `src/browser/locate.ts:27-120`
- Captured in the page by the observer script — `src/recorder/observer.ts:9-25`

## Connected to

- **owned-by:** none (a value type)
- **joins:** [[flow]] (`fp.act`), [[recording]] (`Action.target`), [[outline]], [[fix]], [[screen]] (`shows`, `hides`), [[approval]] (`paymentGate(act, hints)`), the agent digest (`hintsFor(ref)`, `src/agent/digest.ts:407`)
- **looks-like-but-is-not:** `DesktopTarget` (`src/desktop/types.ts:16`)

## If you change this

- **Hits:** `src/browser/locate.ts`, `src/recorder/observer.ts`, `src/compiler/outline.ts:11-24` (its own hints schema), `src/compiler/render.ts:47`, `src/browser/repair.ts`, `src/browser/fixes.ts`, `src/browser/screens.ts`, `src/gates/payment.ts:25-100`, `src/agent/digest.ts`.
- **Does not hit:** desktop ops; site API routes.

## Surfaces

| Surface | Role |
|---|---|
| recorder | writes |
| everything that acts on a page | reads |

## See

- Source: `src/recorder/types.ts`, `src/browser/locate.ts`
