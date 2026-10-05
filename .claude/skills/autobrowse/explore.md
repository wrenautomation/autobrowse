# Explore: drive a browser or the desktop

One browser stays open on a site, signed in through the site's stored login.
You send one JSON command at a time over loopback. Every act that works is
journaled; `save` writes a recording; `compile` makes it a workflow.

## First: does something already do it?

```sh
pnpm -s autobrowse do "<goal>" --dry-run       # routes to a flow, a site route or a workflow
pnpm -s autobrowse workflows [name]            # what exists; a name prints its inputs (--template for a plan file)
pnpm -s autobrowse site status <site>          # the site's API and browser routes
```

## Session

`scripts/` sits beside this file (the skill's folder). Run them from anywhere.

```bash
scripts/start.sh <site> [url] [port] [flags]   # default port 9090; prints "port N" when ready
scripts/cmd.sh <port> '<json>'                 # one command, JSON back
scripts/stop.sh <port>                         # close browser + socket
scripts/state.sh                               # open sessions, resumable journals, profiles
```

`<site>` is a profile name (`google`, `cloudflare`, `aws`, `scratch` = no login;
`<site>@<label>` for a second account). One session per site; `start.sh` on an
open port just reports it. A session that died left its journal:
`start.sh <site> "" <same port>` resumes on its last page, so `save` still has
every act. `stop.sh` ends it for good. Flags for secrets: signup.md.

## Commands

Targets are `hints`: `{role, name, text, placeholder, id, testId, href, inputType, css, nth}`.
Any subset; `name` is the accessible name from `aria`.

Look:
- `{"cmd":"snapshot"}` — interactive elements, one line each. Start here.
- `{"cmd":"aria"}` — accessibility tree, masked. `hints` scopes it, `limit` caps characters (default 12000).
- `{"cmd":"text"}` — the page's words as laid out: side-by-side reads as a row (`Price | $40`), tables across, a sidebar as `[col 1/2]`. Costs what plain text does. `"coords":true` adds `@x,y` per line (+25%); `"layout":false` = DOM order.
- `{"cmd":"url"}`, `{"cmd":"screenshot"}` (path back), `{"cmd":"count","hints":…}`.
- `{"cmd":"pages"}` / `{"cmd":"page","index":1}` or `"main"` — OAuth popups; the session returns to main when the popup closes.

Act (journaled):
- `{"cmd":"open","url":"https://…"}`
- `{"cmd":"click","hints":{"role":"button","name":"Create"},"goal":"…"}`
- `{"cmd":"fill","hints":{…},"value":"…"}`, `select`, `press` (`"key":"Enter"`), `upload`.
- `{"cmd":"type","text":"…"}`, `{"cmd":"key","key":"Escape"}` — into whatever is focused.
- `{"cmd":"place","hints":{…},"secret":"code"}` — types a secret the session holds (signup.md); the value never reaches you. `"secret":"profile.taxId"` fills a field of the Mac's wallet profile (signup.md).
- `{"cmd":"read","hints":{…},"as":"fieldName"}` — text off the page into the flow's output.
- `{"cmd":"records","as":"ads","goal":"…","fields":[{"key":"name","says":"…"},{"key":"site","says":"…","optional":true}],"code":"return [...]"}` — a list page as rows. `code` is a function body over `root` (the document), run in a sandbox and checked; leave it out and the session's model writes one. `key` (default the first field) dedupes, `max` scrolls a feed, `min:0` lets the list be empty. A walk built from the run replays it, with no model.
- `{"cmd":"keep","hints":{…},"env":"X_API_KEY"}` — a secret the site just showed goes straight to the store (`.env` locally, SSM in prod). The journal keeps the element and the name, never the value. This is how keys get set up.
- `{"cmd":"captcha"}` — solves the page's captcha (a checkbox by a human click, a picture by a model, cropped in memory). Returns `{solved, kind, vendor, reason?}`. Never screenshot a captcha yourself.
- `{"cmd":"note","text":"…"}` — a comment in the journal.
- `{"cmd":"eval","js":"…"}` — last resort; not journaled as a click, so the recording misses it.
- `{"cmd":"batch","cmds":[{…},{…}]}` — up to 30 commands in order, one answer, one `changed`. No `close`, `pause`, `resume`, `save` or nested batch.

Desktop, `{"cmd":"os","act":{…}}`: `{"kind":"apps"}`, `{"kind":"open","app":"Finder"}`,
`{"kind":"tree"}`, `{"kind":"click","role":"AXButton","name":"OK"}`,
`{"kind":"type","text":"…","secret":true}`, `{"kind":"key","combo":"cmd+shift+4"}`,
`{"kind":"shot"}`, `{"kind":"shell","command":"…","root":true}`, `{"kind":"wait","ms":500}`.
Needs Accessibility granted to the terminal; root needs `pnpm autobrowse desktop setup` once.

Session:
- `{"cmd":"goal","text":"…"}` — what this run is for. Send it first: a walk is built from runs that share a goal.
- `{"cmd":"done","outcome":"achieved","summary":"…"}` (or `"failed"`) — how the run ended. Send it last, before `save`. A later `goal` starts the next run in the same session.
- `{"cmd":"pause"}` / `{"cmd":"resume"}` — a person acts by hand in between; those acts land in the journal too.
- Headed, no pause needed: when William does a step by hand between two of your
  commands, your next answer carries `helped: {acts, url, changed, note}`. Read
  the page he left; never redo his step.
- `{"cmd":"journal","last":5}` — what is recorded (`total` and the newest `last`).
- `{"cmd":"save","name":"site-what-it-does"}` — writes `recordings/<name>/`.
- `{"cmd":"close"}`.

## How to work

Every look costs tokens. Look once, then let the acts tell you what changed.

1. `start.sh <site> <url>`, then `goal`. The `open` answer already lists the page's controls (`changed.added`).
2. `snapshot`. `aria` with `hints` or a `limit` only when the snapshot is not enough.
3. Every act answers `changed`: `added` (new controls, up to 40), `gone` (a count), `more` (past 40). Read that; don't look again after each act.
4. Acts you are sure of (fill a form, submit) go in one `batch`. It stops at the first failure: `failed: {at, cmd, error}`, `done` holds what ran. A paying click goes alone.
5. Prefer `role`+`name`; fall back to `css`+`nth`. A failed act is not journaled. Change the hints; don't repeat.
6. Never `raw:true` on a page showing a key.
7. Done: `done` with the outcome and a one-line summary, `save` with a kebab name if it should compile, `stop.sh`.

The payment gate: a billing field (card, CVC, tax id, billing address) or a
spending button (Buy, Pay, Subscribe, Add funds, Start trial) texts William and
`cmd.sh` holds until he answers (up to ~45 min); the act runs on a yes. No `eval`
or `type` around it.

## After: a workflow

Every session is a run, kept for good beside the credentials (`explored`).
Two or three runs that reached the same goal become a walk: screens known by
their URL and landmarks, each with the acts that worked on it. A walk runs
as `<site>/walk-<name>` in the catalog, with no model in the loop.

```sh
pnpm -s autobrowse explored <site>                         # runs: driver, goal, outcome, answer tokens
pnpm -s autobrowse walks build <site> <name> --goal-like "<words>"   # or --run id,id
pnpm -s autobrowse walks show <site>/<name>                # screens and ops, never values
pnpm -s autobrowse walks run <site>/<name> --plan key=value [--yes]  # --yes when it has a final act
pnpm -s autobrowse tokens --days 30                        # spend and the verdict
```

Or compile a saved recording to TypeScript:

```sh
pnpm -s autobrowse compile <name>              # → src/workflows/<name>/
pnpm -s autobrowse try <name>                  # run it here, no Restate: proof it is deterministic
pnpm -s autobrowse repair <failure.json>       # an agent picks up where a flow stopped
```

A flow that breaks gets fixed in the flow (a fallback path, a remap), not
handed to William. Failure files: `~/.config/autobrowse/artifacts/`.
