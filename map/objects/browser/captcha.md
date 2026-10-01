---
type: object
cluster: browser
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/browser/captcha/index.ts
---

# Captcha

A wall the runner solves before it goes to a person: `findCaptcha` / `solveCaptcha` in `src/browser/captcha/index.ts`.

## Why this shape

Checkboxes are solved by the hands alone; pictures need `Eyes` (a model that sees, cropped in memory only). `attempts` whole solves, then `NeedsHuman` (`RunnerOptions.captcha`, `src/browser/flow.ts:228-233`).

## Shape

- `Captcha { kind: checkbox|grid|text|slider, vendor: recaptcha|hcaptcha|turnstile|generic … }` — `src/browser/captcha/index.ts:23-31`; `Eyes`, `CaptchaOutcome`, `SolveOptions` — `:32-45`
- Wired by `captchaFor` — `src/app/services.ts:316`

## Connected to

- **owned-by:** the runner; the explore session (`ExploreOptions.captcha`)
- **joins:** [[human-hands]], the LLM seam (`src/llm/types.ts:41`, images)

## If you change this

- **Hits:** `src/browser/flow.ts`, `src/explore/server.ts`, `src/app/services.ts:316`.
- **Does not hit:** sign-ins (a captcha is answered before the wall hook), the engine.

## Surfaces

| Surface | Role |
|---|---|
| runner | calls |

## See

- Source: `src/browser/captcha/index.ts`
