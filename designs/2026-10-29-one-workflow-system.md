# One workflow system: the toolkit, the agent's code, the old flows folded in

Follows `2026-10-29-explore-flow.md` (the `flow` command).

## Goal

Every job autobrowse can do is a workflow in one catalog: compiled, hand-written or built from the agent's code.
Every run goes through the engine, so every run has steps, gates and a trace.
A site route leg keeps today's durability: one Restate entry per leg (see "The fold").

- On a page of a known site, the agent sees that site's workflows without asking.
- Search and a tree find the rest.
- An agent's loop (a scrape of 100 pages) is code over our primitives. It runs in explore and compiles into the workflow like any other act.
- A failed iteration stops the run. The agent fixes the code, and the run goes on from that iteration.
- The trace keeps each iteration's values, as a debugger shows them.

## Target state

| Part | Today | Target |
|---|---|---|
| Catalog | compiled workflows; 67 flows outside it | one catalog; each entry has a site, a one-line aim, a zod plan |
| Run path | engine for workflows; `runner.run(flow)` direct for the old flows | engine only |
| Find | `workflows` lists all; `do` sends the list to a model | the site's toolkit in explore's answers; `tools` tree and `--find` |
| Loops | 100 commands → 100 rows → 100 steps | one `code` command → one op in the compiled step |
| Iteration trace | none | one row per primitive call, with the loop's values |

## 1. The toolkit by site

- Each site login has `home` and `origins` (`auth/login.ts`). A page's host maps to its site through them.
- `start`, `open` and any answer whose page moved to a new site carry `tools`: that site's workflows (name, aim, inputs), at most 20, plus a count of the rest.
  After the fold, the site's route legs are workflows too, so one list holds both. Site API routes (no browser) stay out: `flow` can't run them.
- The same site again: no `tools` (the agent has them).
- `{"cmd":"tools","find":"…"}` in explore; `autobrowse tools [site] [--find …] [--json]` outside.
- `tools` with no site prints the tree: site → workflows → steps and inputs. One branch per call, never the whole catalog.
- `autobrowse sites --find …`: supported sites, with login stored or not, API routes, workflow count.
- Search: MiniSearch (MIT, in-process) over name, aim, site, step names and input names. Fuzzy 0.2 and prefix; an exact name ranks first.
- `do` picks from the search's top 10, not the whole list.

Built (WA-961, 2026-10-29):
- `Workflow` has optional `site` and `hosts`. The compiler renders both (hosts = the browser steps' URL hosts). The 21 compiled workflows were backfilled once; hand-written multi-site ones have no site (the tree's `(any)`).
- Host → sites (`workflows/toolkit.ts`): a login's exact `home` host first, then a shared registrable domain or `origins`, a workflow's own hosts, a domain named for the site (`loom.com` → loom).
  On `admin.google.com` that is google-admin, then the rest of the google family.
- Explore computes it only when the host changes. A host with no site clears it, so a return to the site lists it again.
- A recording's description is its date: its aim is its step names. A leg's aim is `site/name` for now.
- `do` sends the model the search's top 10 plus the same goal's earlier pick. A goal that finds nothing sends the whole list.
- Search is `workflows/find.ts`, apart from the toolkit, so `do` does not load all 108 legs.
- The toolkit holds legs; `backend.workflows` does not yet. The Runs page and `run <name>` run through Restate objects, and a leg has none until pass two.
- `sites` shows "sign-in" (a login spec exists), not "login stored": a stored check reads the credential store per site.
- `flows` (legs with their route callers, walks) stays beside `tools` until pass two folds the run paths.

## 2. One catalog, one run path

See "The fold" below for the per-flow plan.

- A hand-written flow becomes a workflow: its input type becomes a zod plan; its leg becomes one step (`deps.browser.run(flow, input)`), with the gates the leg already meets.
- A part (a leg other flows compose: the consent walker, dialog following) becomes a function legs call. It is not a catalog entry.
- Callers keep their surface (CLI commands, site routes, Restate handlers, npm exports, their return values). Inside, each one runs the workflow through the engine.
- When all callers are moved, a lint fails on any `runner.run(` outside the engine.

## 3. `code`: the agent's code as an act

Named `code`, not `script`: the op kind `script` already means page JS (`browser/flow.ts`).

```json
{"cmd":"code","as":"rows","code":"let url = plan.start; while (url) { await fp.open(url); rows.push(...await records(spec)); url = await fp.read({css:'a.next'}) }","plan":{"start":"https://…"}}
```

- `code` is a function body. In scope: `fp` (open, act, read, has, wait, human), `records(spec)`, `log(values)`, `plan`, `rows`.
  `fp` is built by hand from those methods, never a spread of explore's page: `fp.page` is `undefined`, so no click goes around the money gate.
  No `require`, no `fs`, no `eval`, no network outside `fp`. It runs in a `node:vm` context: a guard against mistakes, not a security wall (the code is our agent's).
- Each `fp.act` goes through explore's money gate, as in a `flow`. A gate or a person's need stops the command as it stops a `flow`.
- The answer: `rows` (counted), `first` (5 rows), the last `log`, `calls`, `stored`, the page, and `failed {call, i, n, url, log, error}` when it failed. `call` null: the code itself threw.
- Inline only. A file would cost a write and a cleanup for the same text.
- `plan` holds the inputs, as strings. Compile turns each into a plan field of the same key; it never guesses which values are inputs.
- Code or plan that holds a secret is refused: secrets go on the page by `place`.
- Journal: one row, `kind:"code"`, with the code, `as` and the plan. Its inner ops are not journaled. Compile renders `out.<as> = (await runCode(fp, {plan, code})).rows`; a walk runs the same `runCode`.

### Durable iterations

- Each `read`, `has` and `records` saves its result under a key: the call, its arguments, the URL of the last `open`, and n, the count of earlier calls with the same key in this run.
  The URL alone is not enough. A "Next" button on one URL, or an infinite scroll, makes the same call on the same URL each page: without n, the rerun gets page 1's rows 36 times.
  During a replay the page is not loaded, so the URL is the last `open`'s, not `page.url()`.
  An edit breaks a key only when it changes how many same calls run per page.
- A rerun (after a fix, or after a crash) returns a saved result without touching the page. The first call with no saved result runs live.
- So page 37 fails, the agent fixes the code, sends it again, and pages 1–36 come back from the store at once.
- Keys use what a call does, not its place in the code. An edit to the code still finds the saved pages.
- `open` is lazy: it navigates before the next live call, even to the URL the page is on. A run of only saved calls ends with one navigation to the last `open`.
- Acts (`fp.act`) never replay: they change the site. A loop that acts per item does those acts again on a rerun; keep acts to navigation, or carry where to start in `plan`.
- Explore's store is a file beside the journal, scoped by `as` and the plan; it goes with the journal on close. `fresh` starts over. A compiled run's store is in memory for now.
- `wait` after an `open` not yet loaded is held, and runs once the page loads: a replay waits for nothing.
- A sandbox `records` is checked as the command is: a required field empty on most rows fails the call.
- Limits: 30 min and 20,000 calls a run, checked at each call. The vm timeout (5 s) stops only sync code before the first `await`: a sync loop after one is not stopped.
- Rule for the agent (in the skill): no `Date.now()`, no `Math.random()`, no literal secrets. The first two break the keys.

### The iteration trace

- Each primitive call is one `call` row in the run history (`runs/log.ts`): the call, its arguments, n, the URL, ms, stored or not, its result (text cut at 300 chars, rows counted), the error.
- `log({page, url})` adds the loop's own values to the row of the next call.
- So a person reads iteration 37 as a debugger shows it: the values, the call, the error. `autobrowse explored show <run>` prints them.

Built (WA-962, 2026-10-29): `browser/code.ts` (`runCode`, `CodeFailed`, exported), the `code` command, the `call` row, the `code` Action, outline op and walk op, the render.
Not yet: large rows to the run's files with a reference in the trace and the engine's state; a saved trace and a file store for compiled runs. Both wait for the run recorder (WA-963).

### Later: code calls a workflow

`flow(name, plan)` inside code is not in the first build. It needs a design: a nested run's steps and trace under the caller's, its gates shown to the caller, and what `advance` does with a step that holds a run.
Until then, the agent sends `flow` and `code` as separate commands, and the journal keeps them in order.

## The fold

Survey, 2026-10-29: 108 flows in `browser/flows/`. 104 are in `BROWSER_FLOWS` (`engine/browser-service.ts`); not there: `cloudflareAccountId`, `cloudflareApiToken`, `awsCliLogin`, `wranglerLogin`.
No flow has a zod input. Parts: `consentFlow`, `kit.ts`, `dialogFollowing`, `go`, `readPosts`, `signedInAs`, parsers.

Run paths today:

| Path | Example | Engine |
|---|---|---|
| Site route leg: `facade.call` → `legOf` → `runner.run` | `sites/linkedin.ts` | no |
| Setup step, OAuth consent leg, armed `prepare` | `facade.ts` `setup`, `armLeg` | no |
| Restate `browser/flow` and its fixed handlers | `browser-service.ts` `runLeg` | no (Restate journal only) |
| `do` verb | `do/wire.ts` | no |
| CLI and chores | `cli-auth.ts`, `chores/aws-login.ts` | no |
| Hand-written and compiled workflow steps | `domain/steps.ts`, `bootstrap`, compiled | yes |

A direct run writes a flow row and failure artifacts, with no run id and no steps. An engine run has steps, gates and a run row.

Plan:
- One adapter, `legWorkflow(flow, input: zod)` (`workflows/legs.ts`): a one-step workflow around the leg, named `<site>-<name>`. The catalog holds all 108 this way, after the compiled ones.
- The zod inputs are generated: `pnpm gen:flow-inputs` reads each leg's input type with the TypeScript checker and writes `browser/flows/inputs.gen.ts`.
  Each entry is held to its leg's type, so a changed input fails typecheck until it is made again. A test fails on a leg with no entry.
  An optional field only code passes (a key sink) is left out, so every input is JSON an agent can send.
  The route's `request` schema stays the route body; `browser.input` still maps it.
Pass one (done 2026-10-29): the catalog and the adapter. Explore's `flow` runs any leg.

Pass two (WA-963) waits on one decision: what an in-memory run writes. `runFlow` on memory effects writes nothing today, so moving a caller onto it changes no row a person can read.
First a run recorder (a run row with its steps, status and artifact paths, in the runs ledger), then the paths below, then the lint.

- Every path above calls `runLeg(name, input)`: the adapter under `runFlow` on memory effects. Return values and errors stay as they are.
  Restate handlers already wrap the leg in `ctx.run`, and Restate forbids `ctx` calls inside it. So a site route keeps one Restate entry per leg, as today, and gains steps and a trace.
  Moving those handlers onto the run object would give per-step durability, but it changes the handler. Not in this pass.
- `armLeg`'s `prepare` becomes the workflow's first step.
- Flows outside `flows/` (auth enroll, rotate-password, unsubscribe, walks) go the same way, in a second pass. They type passwords and keep one sign-in try per site, so they move alone, each with its own check.
- Then `runner.run` is private to the engine, and a lint holds it there.

Check that usage stays the same: the desk's `calls-*.jsonl` ledger, route success rates the week before and after.

Cost: one more in-process call per leg (`advance` on memory effects), under 1 ms. No model, no network.

## Options

### Where the loop lives

| Option | Verdict |
|---|---|
| A. Loops inside compiled workflows (from the agent's script) | **Chosen**. One workflow holds the whole job (William) |
| B. The agent calls `flow` once per page | No: 100 agent turns |
| C. A loop tool around a one-page workflow (`each --over`) | No: a second thing to remember |
| D. `repeat`/`if` fields in batch JSON | No: invents a language; the agent writes TypeScript |

### How a rerun skips finished iterations

| Option | Verdict |
|---|---|
| A. Save each primitive call's result by what it does, plus its count at that URL | **Chosen**. Survives most edits; nothing new for the agent to learn; same-URL pages stay apart |
| B. Positional replay (Restate's own journal) | No: an edited script no longer matches its journal |
| C. An `each(items, fn)` helper that saves per item | No: one more thing the agent must use right |
| D. One engine step per iteration, made at run time | No: a bigger engine change for the same result |

## Decision log

- 2026-10-29: One system. The old flows become workflows; the direct path is deleted, no compat. Usage stays the same (William: "make sure the usage will stay the same").
- 2026-10-29: The toolkit comes from the page's host, not a search (William: "if we're on cloudflare … the agent should just see the cloudflare workflows").
- 2026-10-29: Search is fuzzy (my call): typos find the workflow; exact names rank first.
- 2026-10-29: A script is generated code: it slots into the workflow beside the acts (William).
- 2026-10-29: Inline code, not a file (William: a file "might be over engineering").
- 2026-10-29: Durable by saved call results. A failed iteration: the agent fixes the script, the run goes on from there (William: "it should just continue from 37").
- 2026-10-29: Site route legs keep one Restate entry per leg: Restate forbids `ctx` inside `ctx.run`, and moving the handlers would change their usage.
- 2026-10-29: A script's nested `flow` call waits for its own design.
- 2026-10-29: Leg inputs are generated into one file, not written beside each of 108 legs. The types stay the one source; the generated file cannot drift past typecheck.
- 2026-10-29: Pass two (run paths, lint) waits for the run recorder. A lint that forces a path with no record would be a no-op.
- 2026-10-29: The command is `code`, not `script`: `script` already names the page-JS op.
- 2026-10-29: Explore keeps saved call results in a file beside the journal, not in the run history: the store is resume state and goes on close; the history keeps only the trace.
- 2026-10-29: A workflow names its site in code (`site`, rendered by the compiler), not in outline.json beside it: one source, and hand-tuned workflows have no outline.
- 2026-10-29: `do` shortlists by search before the model: about 10 rows a pick instead of 150, so the pick prompt stays the same size as the catalog grows.
- 2026-10-29: The trace holds each iteration's values (William: "at each iteration of the for loop what the values are").
