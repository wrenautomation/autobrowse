# Batched agent plans and flow resume

2026-10-20. Ask from William through the application-system session. The use case is Workday and other multi-page ATS forms.

## Goals

1. The explore agent reads a page once, plans several acts for it, and runs them without a model call between them.
2. A flow that stops for a person or a crash continues at the step that stopped, not at step 1.
3. A run that fails while the browser opens still writes a flow-run row.

## 1. Batched plans

### Today

`exploreWithAgent` (`src/agent/explorer.ts:140`) does this for each step: it reads the outline, makes one model call and does one act. A 15-field form page takes about 16 model calls.

### Target

The model replies with `{"thought", "actions": [...]}`, which holds 1 to `maxBatch` acts. Each act has today's action shape. The code runs the acts in order and journals each one as today, so compile does not change. The model reads the page again only when the batch ends.

Each act has a precondition before it runs. The code finds the act's ref by its digest hints, and the ref must be visible and enabled. When the act is a fill or a select, the field's role and name must still match. No model call is needed for this check.

A batch ends after the last act, or at the first miss. A miss can be one of these:
- `gone`: the target is not found or not visible;
- `navigated`: the URL changed;
- `dialog`: a new `dialog` or `alertdialog` opened (a listbox popup does not count);
- `invalid`: a new `alert`, or a field that shows `invalid`;
- `error`: the act threw.

After a miss, the code reads the outline again, and the model plans from there. The acts not done are shown to the model as "not run". The miss goes in the journal and on the step's ledger row (`missed`).

These rules keep each batch on one screen. They are William's safeguard and the code applies them, not the model:
- `maxBatch` is 6 by default and can be set (`AgentOptions.maxBatch`). At 1, the agent works as today.
- Only these acts can be in the middle of a batch: `fill`, `place`, `select`, `upload` and `read`, plus a `click` on a ref whose role is `checkbox`, `radio`, `option`, `switch`, `tab` or `combobox`.
- Any other act ends the batch, even when the model planned more after it. These are a button or link click, `press`, `open`, `key`, `captcha` and `os`. So a submit, a "next" or a purchase is always last, and it still goes through the payment gate in `explore/server.ts`.
- `done` and `human` must be the only act in their reply.

The model's tokens for one call go on the first act of the batch. `StepRecord` gets `batch` (the step number of the first act) and `missed`.

### Critique

- **Conditional fields.** On some forms, an answer shows a new field (for example, "authorized to work? No" shows a visa field). The plan misses it, but it does no harm: the next read shows the empty field. Do not try to predict it.
- **Cost of the checks.** One locator check costs about 20 to 50 ms. A model call costs 2 to 10 s.
- **Estimate.** One form page goes from about 16 model calls to 2 or 3. That is about 5 times fewer input tokens per page.
- **Prior art.** browser-use (Python) sends several actions per step and stops when the page changes. That is the same idea and shows it works. We do not import it, because our loop, digest and journal are already TypeScript.

## 2. Resume

### Today

A `NeedsHuman` or a crash throws, and a retry runs the flow from its start. The `DoneActs` record (`browser/attempt.ts`) only stops an irreversible act from running twice.

### What cannot be done

There is no general way to start a hand-written flow function at its line N. The code before line N holds the state in local variables.

### Target: resume through screens

A flow built on `walk` (`browser/screens.ts:423`) finds the screen it is on by looking at the page. Thus it resumes on its own when the page is there. Two parts are missing:

1. **Where to go back to.** When a `withCall(key, ...)` run ends without success (needs a person, failed, interrupted), the runner saves `{ url, profile, screensDone, at }` under the call key, in `<state>/resume/<hash(key)>.json` (mode 0600). The next run under the same key does this:
   - its first `fp.open` goes to the saved URL instead, if the host is the same;
   - `walk` adds the saved screens to its path, so `after` rules hold.

   On success, the record is deleted. Records older than 7 days are not used.
2. **The page itself.** With `park`, the runner keeps the browser and the tab after `NeedsHuman` (`keepPage` already exists). The person fixes the page, and the rerun continues on that same tab. Without a kept tab, the saved URL is opened again. Workday and most ATS sites keep a draft on the server, so the page comes back at the right step.

To turn it off: `RunnerOptions.resume: false`, or `flowRunner` with no call key.

A flow that is not a walk gets only the saved URL. It resumes when its own code checks where it is. The application session's greenhouse, ashby and lever flows are short, so a restart costs little. Workday flows should be written as walks.

## 3. The open-failure row

`flowRunner` writes a row with outcome `interrupted` or `failed`, goal `"open the browser"` and `acts: 0`. It does this when `openSession` throws.

## Decision log

- 10-20: The code ends batches, not the model. A precondition, the act's kind and the page's state end a batch. A model that plans too far cannot run more than one screen's worth.
- 10-20: `maxBatch` is 6 by default. William asked for 5 to 8, configurable, and no 20-step plans.
- 10-20: Resume works through screens and the call key. It does not jump into a function. Restate-style replay of each act was rejected: after the browser closes, the page state is gone, so a replayed "skip" does nothing.
- 10-20: Resume is on by default when there is a call key. Without a key, there is nothing to match the run to.
