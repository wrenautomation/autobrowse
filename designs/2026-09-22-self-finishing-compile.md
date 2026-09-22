# Self-finishing compiles

2026-09-22. Every compiled workflow so far got the same last mile by hand in
Claude Code: plan inputs for what the recording hard-coded, the fill and
the submit as two steps with a `send` gate between, a proof read after the
irreversible act, a gate test. `compile --finish` (and `finish <name>`)
hands that mile to a model under the same judge a person uses: tsc and the
workflow's own test. The model proposes whole files; the check disposes.

## How it runs

`src/compiler/finish.ts`. Input: the module, its test, its outline, the
hand-finished `aws-port25-request` as the exemplar, an optional brief.
Reply: `{"index.ts", "index.test.ts", "notes"}` or `{"unchanged": true}`.
The files are written, formatted, checked (`src/compiler/check.ts`: the
repo's tsc read for the workflow's own lines, then `vitest run <dir>`).
Errors go back to the model with its own files; three rounds; a give-up
or a thrown model call restores the originals. Every call is a traced LLM
span like any other (`2026-09-22-observability.md`).

Wired: `compile <name> --finish`, `finish <name> [--brief]`, and heal —
after the re-render, before the proof, so what the model finishes is what
gets proven. The Backend exposes `finish(name, brief?)` when a model is set.

## What the model may do

Only `index.ts` and `index.test.ts` of that workflow; imports only from the
library path the module already uses, zod and vitest. Never `gate("human")`
in a step (that gate is the host's). A rejected or thrown check leaves the
files as they were: a finish cannot make a workflow worse than its template.

## Proven

`instagram-profile-basics`, command-a-03-2025, one round, 4k in / 2k out:
fill/upload split, `send` gate with the file in the prompt, proof read,
memo skip on re-run, gate test. Two earlier attempts gave up on invented
imports (`gate`, `fp`) until the prompt listed the library's exports; a
stronger model (Anthropic, once credits are in) needs less prompt.

## Decisions

- Whole files, not patches: a rendered module is ~100 lines and patches
  from a model misapply; the check makes a bad whole file cheap.
- tsc over the repo, filtered to the workflow: the module imports the
  library, so its errors only mean anything against the real types.
- No branch/worktree: the loop restores on failure, git diff shows the rest.
- Heal finishes before proving: a proof of the template would be thrown
  away by the finish that follows.

## Where to attack

1. ✅ `finish()` + check + restore; tests
2. ✅ `compile --finish`, `finish <name>`, heal hook
3. ✅ first real finish on a compiled workflow
4. Finish every compiled workflow that is still template-shaped
   (`instagram-change-email`, `google-cloud-project`, `signup-instagram`)
   and prove them
5. A `finish` job in the UI's Workflow page (the CLI is enough now)
6. Let the finish read the recording's aria snapshots so proof reads name
   real confirmation text, not a guess
