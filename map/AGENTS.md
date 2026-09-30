# autobrowse — system map

Nouns, verbs, and what a change hits, for an agent editing this repo. The code is the truth; every card cites it. Built on ICM: folders route, files carry state.

## Where things live

| Folder | Holds |
|---|---|
| `objects/<cluster>/` | one card per noun (a type, a durable file), with `path:line` citations |
| `objects/_index.md` | one line per noun: cluster, universe, status (generated) |
| `processes/` | the movements that actually run: sign-in, run-step, site-call, build, heal, do, deploy |
| `effects/CONTEXT.md` | "changing X → open these cards", plus what points in from outside the tree |
| `_meta/schema.md` | card types, frontmatter, naming; `_meta/rebuild.sh` regenerates `_index.md` and the twins |
| `_templates/` | copy one to start a card |

## Route by question

| If you ask | Open |
|---|---|
| what is X | `objects/_index.md`, then the card |
| what moves if I change X | `effects/CONTEXT.md` |
| how a sign-in, run, site call, build, heal, `do`, or deploy goes | `processes/<verb>.md` |
| how the product works, the commands, the layout | `../README.md` (the entry file) |
| why it is shaped this way | `../designs/` (dated docs with decision logs) |

## Names that collide

| Word | Means | Not |
|---|---|---|
| site | a browser profile name: `x`, `x@wren` (`Site = string`, `src/browser/flow.ts:61`) | `SiteApi`, the official-API facade (`src/sites/types.ts:155`); `SiteLogin`, the sign-in spec (`src/auth/login.ts:55`) |
| workflow / flow / walk | engine `Workflow` = steps + gates on Restate; `BrowserFlow` = one browser leg; walk = a screens loop inside a sign-in | a compiled workflow wraps flows; none of the three is another |
| step | engine `StepDef`; an outline step (compiler); a watched `Step` (`browser/watch`); an agent `StepRecord` | |
| screen | `browser/screens` = a page a walk knows; `src/app/screen.ts` = headed or headless | |
| repair / fix / heal | repair = the runner retries one act through a `Repairer`; fix = a repair kept in `fixes.json`; heal = the agent rewrites a compiled step | |
| gate | engine `GateName` on a run (purchase, password, send, choose, human); `PaymentGate` = one browser act that spends | guards (`src/engine/guards.ts`) switch engine gates off; they never touch the payment gate |
| identity | `auth/identities` = an account with purposes; `browser/identity` = the browser's UA and geometry | |
| IdentityProvider | `auth/providers` = a sign-in (google, github, microsoft); `auth/identities` = where an account lives (google, microsoft) | |
| account | an `Identity` (address + purposes); a `<site>@<label>` credential name; an `AccountRow` (what is stored per site) | |
| session | browser `Session` (a context + page); agent `SessionView`; explore session (a port + journal) | |
| need / owed | `Need` = one thing only the person can give, with a check; `Owed` = the list with done-marks | `NEEDS-WILLIAM.md` is kept by hand |

## Universes

live = in force. leftover = still present, not the main path: `src/mcp/` (Claude Code uses the skill, not MCP), `src/workflows/example-title/` (a compiled demo no route names). ghost = none found. Each card says which.

## The one rule

A card marked `verified` carries a date, a commit and citations. When code and card disagree the code wins; fix the card the same day.
