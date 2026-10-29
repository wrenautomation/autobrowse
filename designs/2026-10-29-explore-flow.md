# Explore runs saved workflows (WA-959)

## Goal

The agent combines workflows itself: sign in, explore, run `amazon-cart`, explore again.
No flag per combination. A workflow is a tool the agent calls on the open page.

`{"cmd":"flow","name":"amazon-cart","plan":{"searchFor":"Dune"}}` runs a compiled workflow on the session's page.
Its result comes back as JSON. A failure leaves the page open, and the agent goes on by hand.

## Options

| Option | How | Verdict |
|---|---|---|
| A. `flow` command in explore | Any compiled workflow runs on the open page | **Chosen** |
| B. Flow falls back to explore | A flow parks the page for an agent on an unknown screen | A hard flow does this itself already (William) |
| C. Chain flags (`--then explore`) | One flag per combination | No: does not scale |
| D. A language that chains flows | Sequence and branch in a script | No: the agent sequences and branches |

## Rules

- **What it runs:** compiled workflows only (`compiledCatalog`: the user dir, shipped, mods).
  Their deps are the browser alone, and their plan is a zod schema with defaults.
  Hand-written workflows (domain family) need APIs, and raw `BrowserFlow`s have no plan schema or gates: refused.
- **One page, one runner:** the workflow's `browser.run(flow)` runs `flow.run` on explore's own `FlowPage`.
  No second browser and no profile lock. `compiledDeps` binds secrets to the flow's site and audits each fill.
- **Site:** each browser leg's `site` must be the session's site (its profile).
  Another site's leg would run on the wrong cookies, and its wall sign-in would use the session's account. Refused: "open explore on <site>".
- **Money:** every click, fill, select and activating press of the flow goes through explore's payment gate first.
  The flow cannot buy what explore would ask about.
- **Workflow gates:** `purchase`, `password` and `send` ask a person (explore's approver, the one yes per ask).
  `?wait=1` holds until the answer. Without it the call answers "asked"; send it again.
  `choose` and `human` stop the run. The answer names the gate. The agent or a person fixes it, then sends the same command.
  The step runs again from its first `open`: a fix the site keeps holds, a fix on the page only does not.
  A no ends the run as `rejected`.
- **State between calls:** a stopped run is kept by name for the session, so the next call goes on from its gate. `fresh:true` starts over. A finished run is dropped.
- **Pause:** each step waits while the session is paused. A person can stop a flow between steps.
- **Overlay:** one trace row per step (`open`, act, `read`), as a flow shows on its own. Never a typed value.
- **Secret flows (`secret: true`):** no rows, no step pictures, no flat journal. The network log rows it made are dropped at the end.
  The journal keeps a start note and an end note only.
- **Journal:** a plain flow journals its acts flat (navigate, click, input, select, press, eval), bracketed by notes `flow <name> start` and `flow <name> <status>`.
  So a mixed session saves as one recording that compiles alone.
- **Resume:** a resumed session reopens the last page. It never replays acts, so a flow never runs twice by itself.

## Decision log

- 2026-10-29: A over B–D. William: "i agree with A". B already exists inside hard flows.
- 2026-10-29: Journal flat, not a new `kind:"flow"` action. A flow action needs the compiler to emit sub-workflow calls. Flat acts compile today and make a mixed session one workflow.
  Later: a `flow` action, if a recording should call a workflow by name and pick up its fixes.
- 2026-10-29: Compiled workflows only. Hand-written ones need API deps that explore does not hold.
- 2026-10-29: Not reachable yet: the hand-written `BrowserFlow`s in `browser/flows/` (`cloudflare-token` and others). Their callers need worker deps.
  Later: a typed catalog of those flows, each with a zod input, so `flow` runs them too.
- 2026-10-29: Overlay busy is a count. A `flow` command's steps nest in it, and `hold` covers hands between steps (a banner wait, a scroll). The panel takes clicks only while nothing of ours acts.
- 2026-10-29: Click-through mode fades the panel to .32 opacity (William: "it should be translucent ... everything in it should be dimmed"). Busy does not fade: it flips per step and would blink; `● run` marks it.
- 2026-10-29: Same-site legs only. `--login` sites hold place secrets, not a profile.
- 2026-10-29: Overlay panel takes clicks by default (`[●]`). William: "defaulting to not clicks going through the panel is fine". While a command runs, the panel still lets every click through: the hands click at coordinates.
