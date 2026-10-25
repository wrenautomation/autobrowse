# autobrowse — system map

Nouns, verbs, and what a change hits, for an agent editing this repo. The code is the truth; every card cites it. Built on ICM: folders route, files carry state.

## Where things live

| Folder | Holds |
|---|---|
| `objects/<cluster>/` | one card per noun (a type, a durable file), with `path:line` citations |
| `objects/_index.md` | one line per noun: cluster, universe, status (generated) |
| `processes/` | the movements that actually run: sign-in, run-step, site-call, build, heal, do |
| `effects/CONTEXT.md` | "changing X → open these cards", plus what points in from outside the tree |
| `_meta/schema.md` | card types, frontmatter, naming; `_meta/rebuild.sh` regenerates `_index.md` and the twins |
| `_templates/` | copy one to start a card |

## Route by question

| If you ask | Open |
|---|---|
| what is X | `objects/_index.md`, then the card |
| what moves if I change X | `effects/CONTEXT.md` |
| how a sign-in, run, site call, build, heal, or `do` goes | `processes/<verb>.md` |
| how the product works, the commands, the layout | `../README.md` (the entry file) |
| why it is shaped this way | `../designs/` (dated docs with decision logs) |

## One word, one meaning

Each word below has one meaning. A thing that used to share a word has its own word now; the Code column gives its name in the source.

| Word | Means | Code |
|---|---|---|
| Chrome profile | one browser profile, named per account: `x`, `x@wren` | `Site = string` (`src/browser/flow.ts:61`) |
| site API | a site's official API behind one facade | `SiteApi` (`src/sites/types.ts:155`) |
| login | how one site signs in | `SiteLogin` (`src/auth/login.ts:56`) |
| sign-in provider | the account a login goes through: google, github, microsoft | `IdentityProvider` (`auth/providers`, `auth/identities`) |
| workflow | engine steps and gates on Restate; a compiled workflow wraps flows | `Workflow` |
| flow | one browser leg | `BrowserFlow` |
| walk | a screens loop inside a sign-in; a built walk ([[walk-spec]]) is that loop as data, run as flow `<site>/walk-<name>` | `src/walks` |
| run | one engine run ([[run-object]], `autobrowse runs`) | |
| exploration | the history of one explore session ([[explore-run]], `autobrowse explored`) | |
| recording | one saved journal | `recordings/` |
| plan | a workflow's input; the saved default plan (`<plansDir>/<workflow>.json`) is the operator's values, merged under every start | `PlanStore` (`src/workflows/plans.ts`) |
| step | one unit of a sequence, in the layer that holds it | `StepDef` (engine), outline step (compiler), `Step` (`browser/watch`), `StepRecord` (agent) |
| screen | a page a walk knows | `src/browser/screens.ts` |
| display | headed or headless, for every browser opened from now | `Display` (`src/app/display.ts`) |
| repair | the runner retries one act through a `Repairer` | |
| fix | a repair kept in `fixes.json` | |
| heal | the agent rewrites a compiled step | |
| gate | a stop that waits for a person's yes: `GateName` on a run (purchase, password, send, choose, human), or `PaymentGate` on one browser act that spends. Guards (`src/engine/guards.ts`) switch run gates off; they never touch the payment gate | |
| identity | an account with purposes (address + purposes) | `auth/identities` |
| fingerprint | what the browser tells a site about the machine: UA, client hints, geometry | `Fingerprint` (`src/browser/fingerprint.ts`) |
| credential | a username and roles on one site (`auth/roles`); its stored row is an `AccountRow` | |
| role | what one credential is for on its site (`main`, `wren`) | |
| purpose | which address a site call runs as (`default`, `pays`) | |
| session | a live browser context and page; the agent and explore each hold one | `Session`, `SessionView` (agent), an explore port + journal |
| owner | a tenant: `AUTOBROWSE_OWNER`, its files, SSM path, Restate names | `src/owner.ts:11` |
| operator | the person who runs this install (`AUTOBROWSE_OPERATOR`, default `me`); the UI token with all rights is their scope | `OPERATOR` (`src/access/keys.ts:40`) |
| opener | the process that opened a browser: `desk`, `explore:<port>`, `cli`, `orphan` | `Opener` (`src/browser/browsers.ts`) |
| billing profile | a person or company a card bills to: address, contacts, tax id (`autobrowse profile`, `wallet bill-to`) | `Profile` (`src/money/profile.ts`), `Card.profile` |
| need | one thing only the person can give, with a check | `Need` |
| owed | the list of needs with done-marks | `Owed` |

## Universes

live = in force. leftover = still present, not the main path: `src/workflows/example-title/` (a compiled demo no route names). ghost = none found. Each card says which.

## The one rule

A card marked `verified` carries a date, a commit and citations. When code and card disagree the code wins; fix the card the same day.
