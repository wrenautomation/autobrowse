---
type: object
cluster: build
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/compiler/outline.ts
---

# Outline

The compiler's editable middle: a recording reduced to named steps, typed plan fields and replayable ops, saved as `outline.json` beside the recording: `outlineSchema` in `src/compiler/outline.ts`.

## Why this shape

Plain data with a schema, so a person or a model edits names, proofs and gates before source is rendered. A value a person typed becomes a plan field; a redacted one becomes a secret fetched by key at run time (`src/compiler/outline.ts:1-8,28-32`).

## Shape

- `outline { name, site, description, fields, secrets, steps }`; a `{field}` in a step URL must be a declared field — `src/compiler/outline.ts:115-139`
- Steps: `browser` (url, ops), `terminal` (commands), `desktop` (ops) — `:102-113`; ops and desktop ops — `:34-84`; `fieldSchema` — `:85`
- `OUTLINE_FILE = "outline.json"` — `:145`; `structure(rec)` makes one — `src/compiler/structure.ts:135`; `polish` names things with a model — `src/compiler/polish.ts:55`
- Patched by `swapHints` / `replaceOp` (`src/compiler/patch.ts:63-90`) and by heal; read and saved through `Backend.outline` (`src/app/backend.ts:100-103`)

## Connected to

- **owned-by:** its recording dir, then the compiled workflow dir
- **joins:** [[recording]], [[compiled-workflow]] (`render(outline)`), [[hints]], [[token]] (`keep` ops)
- **looks-like-but-is-not:** the rendered `index.ts` (the source is the truth after render; the outline is what heal re-renders from)

## If you change this

- **Hits:** `src/compiler/structure.ts`, `src/compiler/render.ts:256`, `src/compiler/polish.ts`, `src/compiler/patch.ts`, `src/agent/heal.ts:72-135`, every `src/workflows/*/outline.json`, UI `/api/workflows/:name/outline` (`src/ui/api.ts:346-369`).
- **Does not hit:** hand-written workflows (`domain`, `bootstrap`); the engine.

## Surfaces

| Surface | Role |
|---|---|
| compiler, heal | write |
| UI outline editor, a person | edit |

## See

- Source: `src/compiler/outline.ts`
