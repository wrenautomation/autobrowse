---
name: autobrowse
description: Research the web (read a page, search) and drive a signed-in browser or this Mac's desktop through autobrowse's explore session (set up an API key on a site, map a page, do a chore, fix a failing flow) so the acts are journaled and compile into a workflow. Use for any browser or OS task in this repo instead of Playwright or manual steps.
---

# autobrowse explore, from Claude Code

One browser stays open on a site, signed in through the site's stored login.
You send one JSON command at a time over loopback. Every act that works is
journaled; `save` writes a recording; `compile` makes it a workflow.

Scripts live beside this file (`scripts/`); run them from anywhere.

## Session

```bash
scripts/start.sh <site> [url] [port]   # default port 9090; prints "port N" when ready
scripts/cmd.sh <port> '<json>'         # one command, JSON back
scripts/stop.sh <port>                 # close browser + socket
```

`<site>` is a profile name: `google`, `cloudflare`, `aws`, `anthropic`, `sentry`,
`twilio`, `instantly`, `google-admin`, or `scratch` (no login). Profiles
are listed by `pnpm autobrowse creds list`. Start one session per site;
`start.sh` on an open port just reports it.
A session that died (crash, idle close) left its journal: `start.sh <site> "" <same port>`
resumes it on its last page, so `save` still has every act. `stop.sh` ends it for good.

Login is the profile's job. Never type a password, TOTP or code yourself.
If a wall stays up, say so and stop.

## Commands

Targets are `hints`: `{role, name, text, placeholder, id, testId, href, inputType, css, nth}`.
Any subset; `name` is the accessible name from `aria`.

Look:
- `{"cmd":"aria"}` — accessibility tree, masked. `hints` scopes it, `limit` caps characters (default 12000).
- `{"cmd":"snapshot"}` — interactive elements, one line each.
- `{"cmd":"text"}`, `{"cmd":"url"}`, `{"cmd":"screenshot"}` (path back).
- `{"cmd":"count","hints":…}`.
- `{"cmd":"pages"}` / `{"cmd":"page","index":1}` or `"main"` — OAuth popups; the session returns to main when the popup closes.

Act (journaled):
- `{"cmd":"open","url":"https://…"}`
- `{"cmd":"click","hints":{"role":"button","name":"Create"},"goal":"…"}`
- `{"cmd":"fill","hints":{…},"value":"…"}`, `select`, `press` (`"key":"Enter"`), `upload`.
- `{"cmd":"type","text":"…"}`, `{"cmd":"key","key":"Escape"}` — into whatever is focused.
- `{"cmd":"read","hints":{…},"as":"fieldName"}` — text off the page into the flow's output.
- `{"cmd":"keep","hints":{…},"env":"X_API_KEY"}` — a secret the site just showed goes straight to the secret sink (`.env` locally, SSM in prod). The journal keeps the element and env name, never the value. This is how keys get set up.
- `{"cmd":"os","act":{…}}` — desktop: `{"kind":"apps"}`, `{"kind":"open","app":"Finder"}`, `{"kind":"tree"}`, `{"kind":"click","role":"AXButton","name":"OK"}`, `{"kind":"type","text":"…","secret":true}`, `{"kind":"key","combo":"cmd+shift+4"}`, `{"kind":"shot"}`, `{"kind":"shell","command":"…","root":true}`, `{"kind":"wait","ms":500}`. Needs Accessibility granted to the terminal; root needs `pnpm autobrowse desktop setup` done once.
- `{"cmd":"note","text":"…"}` — a comment in the journal.
- `{"cmd":"captcha"}` — solve the captcha on the page: a checkbox by a human click, a picture (squares, letters, slider) by a model that sees. Returns `{solved, kind, vendor, reason?}`. Never screenshot a captcha yourself; this crops it in memory. Unsolved = hand it to William.
- `{"cmd":"eval","js":"…"}` — last resort when hints cannot reach it; not journaled as a click, so the recording will miss it.

- `{"cmd":"batch","cmds":[{…},{…}]}` — up to 30 commands in order, one answer, one `changed` for the lot. No `close`, `pause`, `resume`, `save` or nested batch.

Session:
- `{"cmd":"pause"}` / `{"cmd":"resume"}` — a person acts by hand in between; those acts land in the journal too.
- `{"cmd":"journal","last":5}` — what is recorded so far (`total` and the newest `last`; omit `last` for all).
- `{"cmd":"save","name":"site-what-it-does"}` — writes `recordings/<name>/`. Then `pnpm autobrowse compile <name>`.
- `{"cmd":"close"}`.

## Reading and searching (no browser)

A public page or a search needs no session. These cost a fraction of a browser's tokens:

```
pnpm -s autobrowse read <url> --max 4000          # page as plain text (jina, then a plain fetch)
pnpm -s autobrowse search fee-only RIA Austin -n 5  # exa, brave, then duckduckgo: the first set up
```

`--via fetch` forces a backend; `--json` for machine use. Open a browser only for a page
behind a login or one that renders nothing without scripts.

Lead lists and LinkedIn (reads run as Wren's LinkedIn by the accounts policy, never William's):

```
pnpm -s autobrowse maps "ria in austin tx" --max-minutes 10          # Maps listings → CSV for wren
pnpm -s autobrowse site call linkedin GET "/search/results/people?keywords=ria%20founder&pages=2"
pnpm -s autobrowse people ria founder austin --pages 2 --enrich       # LinkedIn leads CSV → wren --format linkedin; re-run resumes
pnpm -s autobrowse people founder --company <handle> --enrich            # a firm's people, keywords narrow
pnpm -s autobrowse site call linkedin GET "/in/<vanity>?company=true"   # roles + current employer's page
pnpm -s autobrowse site call linkedin GET "/company/<handle>"           # website, size, industry, HQ, phone
pnpm -s autobrowse site call linkedin GET "/company/<handle>/people?keywords=founder&max=30"
pnpm -s autobrowse doctor                                            # what works right now
```

`POST /in/<vanity>/connect` and `/message` send: never without William's yes.

## Before exploring

Something may already do it. `pnpm autobrowse workflows` and `pnpm autobrowse site status <site>` list
what exists; `workflows <name>` and `site route <site> <METHOD> <path>` print the inputs (add
`--template` for a JSON file to fill in and pass as `--plan file.json` / `--body file.json`).

## How to work

Every look costs tokens. Look once, then let the acts tell you what changed.

1. `start.sh <site> <url>`. The `open` answer already lists the page's controls (`changed.added`).
2. Look with `snapshot` (one line per control). Use `aria` with `hints` to scope it, or a `limit`, only when the snapshot is not enough.
3. Every act answers `changed`: `added` (new controls, up to 40), `gone` (a count), `more` (added rows past 40). Read that; do not look again after each act.
4. Several acts you are sure of (fill a form, then submit) go in one `{"cmd":"batch","cmds":[…]}`. It stops at the first failure: `failed: {at, cmd, error}`, with `done` holding what ran. Keep a paying click out of a batch; send it alone.
5. Prefer `role`+`name`; fall back to `css`+`nth`. Errors come back as `{"error","url"}`; a failed act is not journaled. Change the hints, do not repeat.
6. Secrets: use `keep`. Never `raw:true` on a page showing a key. Never echo a value, never put one in a URL or a message.
7. Done: `note` what was achieved, `save` with a kebab name, `stop.sh`.

Money is William's call. A billing field (card, CVC, tax id, billing address) or a button that
spends (Buy, Pay, Subscribe, Add funds, Start trial) is gated: the session texts him and `cmd.sh`
holds the request until he answers (up to ~45 min), then the act runs on a yes.
`{"gate":"payment","reason":…}` with exit 1 means no, unanswered, or nobody could be asked. Do
not work around it (no `eval`, no `type` into the field). Say what was refused and stop.

Never open `www.linkedin.com`. Never change or rotate a stored password. Never wipe a profile.
