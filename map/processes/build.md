---
type: process
status: verified
verified: 2026-09-28 @ 70aefc3
consumes: [explore-session, recording, outline, agent-session]
produces: [compiled-workflow, proof]
---

# build

A page is worked once by hand or by the agent, journaled, and rendered into a workflow that runs deterministically from then on.

## Input → Movement → Output

A site and a goal. Explore (a person through Claude Code, or the agent) acts one command at a time; `save` writes a recording; `compile` structures it into an outline, polishes names, renders `src/workflows/<name>/index.ts` and a test; `check` typechecks and runs it; `finish` has a model fill plan inputs, add a send gate and proof reads; `prove` runs it once on defaults. A compiled workflow, a proof, and an ability `do` can pick next time.

## Why this shape

Recording is the one input, so a build never depends on anyone's memory of what was clicked. The outline is the edit surface between capture and source; rendered source is the truth after that, so a change is made in the file, and heal re-renders only the step that broke.

## Steps

1. Explore: `startExplore(opts)`, commands journaled to `recordings/.explore-<site>/` — `src/explore/server.ts:447,384`; the agent drives the same session — `src/agent/explorer.ts:140`, `src/agent/sessions.ts:72`
2. `save` → `saveRecording` (`manifest.json`; typed values redacted, `keep` carries only the env name) — `src/recorder/store.ts:20`, `src/recorder/redact.ts`
3. `compileRecording(rec, llm)`: `structure` → `polish` → `render` → `saveOutline` — `src/app/backend.ts:164-170`, `src/compiler/structure.ts:135`, `src/compiler/polish.ts:55`, `src/compiler/render.ts:256`, `src/compiler/index.ts:26-45`
4. `checkCompiled(dir)`: tsc and vitest on the rendered dir — `src/compiler/check.ts:14`
5. `finishCompiled` → `finish` (rounds until the check passes; `dropped()` guards against a model deleting steps) — `src/app/backend.ts:192`, `src/compiler/finish.ts:131-205`
6. `proveCompiled` → `proveWorkflow` (gates declined) → `proof.json` — `src/app/backend.ts:150`, `src/workflows/proof.ts:80-93`
7. The catalog sees the new dir at once through the `Compiled` object — `src/workflows/compiled.ts:47-106`

## If you change this

- **Hits:** `src/app/cli-record.ts` (`explore`, `record`, `compile`, `finish`), UI `/api/recordings`, `/api/workflows/:name/prove|outline`, `/api/agent/*`, `.claude/skills/autobrowse/`, `src/do/doer.ts:163-220` (`do` builds through the same path), `src/agent/builder.ts`.
- **Does not hit:** hand-written workflows, sign-ins.

## Surfaces

| Surface | Role |
|---|---|
| Claude Code skill, `autobrowse explore/record` | capture |
| `autobrowse compile/finish/prove`, UI jobs | build |
| agent (`do`, proposals) | capture and build unattended |

## See

- Objects: [[explore-session]], [[recording]], [[outline]], [[compiled-workflow]], [[proof]], [[agent-session]]
- Source: `src/app/backend.ts:150-213`, `src/compiler/index.ts`
