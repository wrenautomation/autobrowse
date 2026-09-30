# Hack the North 2026: demo

Config (`.env.htn.example`), copy and time compression for the Hack the North 2026 demo (2026-09-20). The code is `main`.

## Pitch (30 s)

Every team has browser chores no API covers: buy the domain, flip the
Workspace setting, enrol the authenticator, approve the OAuth prompt.
autobrowse turns one demonstration into a durable workflow that runs
itself, asks a person only where money or consent is involved, repairs
itself when the site changes, and notices what deserves to be automated
next.

## Script (6 min)

1. **Explore** (UI → Explore → new). Site `google@ops`, goal "report the
   account's display name". The agent reads the page as a digest (≈2k
   tokens a step, not a screenshot), clicks, journals one thought per
   page. Pause it mid-run, click once by hand, resume: the hand act is
   in the journal too.
2. **Compile** (Recordings → compile). The trace becomes a typed
   workflow under `src/workflows/`; the model names steps, deterministic
   code checks it compiles. `autobrowse try google-name` runs it with no
   model in the loop.
3. **Gate on iMessage** (Runs → domain → start with a domain). The buy
   step opens a purchase gate; the text lands on the phone via Linq;
   reply `yes` from iMessage; the run continues. Show the Restate
   journal: the gate is state, not a parked process.
4. **Self-repair**. Break a locator (rename a button in the fake site or
   pick a step that fails); the failed step shows "repair with agent";
   the agent explores from the failure record, the fix is remembered in
   Backboard, the next run uses it first.
5. **Self-building**. Explore page → Proposals: the evaluator has read
   failures, sessions and recordings and ranks what deserves a workflow.
   One click starts the agent on it.
6. **Ops**. Sentry issue for the failed step, tagged workflow/key/step.

## Sponsor tracks used, honestly

- OpenAI: explore agent, compiler naming pass, repair proposals, evaluator.
- Backboard: cross-run memory (repairs that worked, hand-off notes).
- Browserbase: the remote browser tier; persistent contexts per site.
- Linq: gates and commands over iMessage from a number we own.
- Sentry: failed runs and steps as issues.

## Time compression

`PACE=fast` removes human pacing; `EVALUATE_EVERY_HOURS=0.05` runs the
evaluator every 3 minutes; `GUARDS=purchase` keeps only the money gate.

## Before the stage

- `.env` from `.env.htn.example`; `autobrowse setup`; `pnpm dev`.
- Linq webhook registered for `message.received` → `<public UI>/hooks/linq`.
- One recording and one failure on disk so Proposals is not empty.
