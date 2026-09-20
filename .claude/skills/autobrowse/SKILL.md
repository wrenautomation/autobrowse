---
name: autobrowse
description: Drive a signed-in browser or this Mac's desktop through autobrowse's explore session (set up an API key on a site, map a page, do a chore, fix a failing flow) so the acts are journaled and compile into a workflow. Use for any browser or OS task in this repo instead of Playwright or manual steps.
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
- `{"cmd":"eval","js":"…"}` — last resort when hints cannot reach it; not journaled as a click, so the recording will miss it.

Session:
- `{"cmd":"pause"}` / `{"cmd":"resume"}` — a person acts by hand in between; those acts land in the journal too.
- `{"cmd":"journal"}` — what is recorded so far.
- `{"cmd":"save","name":"site-what-it-does"}` — writes `recordings/<name>/`. Then `pnpm autobrowse compile <name>`.
- `{"cmd":"close"}`.

## How to work

1. `start.sh <site> <url>`; then `url`, then `aria` (add `limit` on big pages).
2. One act, then look again. Prefer `role`+`name`; fall back to `css`+`nth`.
3. Errors come back as `{"error","url"}`; a failed act is not journaled. Change the hints, do not repeat.
4. Secrets: use `keep`. Never `raw:true` on a page showing a key. Never echo a value, never put one in a URL or a message.
5. Done: `note` what was achieved, `save` with a kebab name, `stop.sh`.

Money is William's call. A billing field (card, CVC, tax id, billing address) or a button that
spends (Buy, Pay, Subscribe, Add funds, Start trial) is gated: the session texts him and waits for
a yes; the answer comes back as `{"gate":"payment","reason":…}` (403) when it is no, unanswered,
or nobody could be asked. Do not work around it (no `eval`, no `type` into the field). Say what
was refused and stop.

Never open `www.linkedin.com`. Never change or rotate a stored password. Never wipe a profile.
