---
type: object
cluster: build
universe: live
status: verified
verified: 2026-09-30 @ baab3e6+
entity: src/explore/server.ts
---

# Explore session

One open browser on a site, driven one JSON command at a time over loopback, every act journaled: `startExplore` / `Explorer` in `src/explore/server.ts`. Claude Code reaches it through `.claude/skills/autobrowse/scripts/`.

## Why this shape

A person or a model maps a page and acts on it; what works is journaled and becomes a recording, then a workflow. A session that dies keeps its journal file and resumes on its last page; idle sessions close themselves.

## Shape

- `Command` (open, click, fill, place, keep, aria, read, records, note, save, os …) — `src/explore/server.ts:220`; `records` journals a records op (the driver's code, else the session's model writes it via `writeRecords`), which a walk built from the run replays; `ExploreOptions` — `:338-420`; `Explorer` — `:447`
- Info file: beside the token file, `explore-<port>.json` (`ExploreInfo`: pid, site, driver, `held`, startedAt; mtime = last command), read by `autobrowse browsers`; agent sessions get a token file too, so they show as `agent:<port>`. `held` = never idle-closes (`explore --hold`, teach). `close {keep:true}` (from `browsers stop`) keeps the journal
- Journal: `journalFileFor(recordingsDir, site, id)` under `recordings/.explore-<site>/` — `:423`; `readJournal` — `:427`; `DEFAULT_IDLE_MINUTES` 30 — `:441`
- Money and secrets on this path: `secrets`/`secretHosts` (place by name), `profiles` (a profile field, any host), `cards`, `cardsOnFile`, `charges`, `approve`, `audit` — `:353-393`; `placeHint` names the flag a missing secret needs — `:261-277`
- Help by hand, no pause: acts a person does between two commands count (`byHand`, `HAND_GRACE_MS` — `:279`, `:595-602`); the next answer carries `helped {acts, url, changed, note}` — `helpedSince` `:1027`
- A target with no `frame` the page lacks is looked for in each visible iframe (`withFrame`, `src/browser/frames.ts`), so `place` on a card provider's hosted field (Braintree) works with plain role/name hints — `:1045-1049`
- History: every command, act and ending also goes to the session's [[explore-run]] (`goal`, `done`; `openRun` `:633`, `endRun` `:660`), which outlives the journal
- `text` reads the page as laid out (`layoutText`, `src/browser/layout.ts`): rendered text blocks cut apart by whitespace (XY-cut) into rows, tables and columns; `layout: false` is `innerText`
- Opened by `explorerOpener` — `src/app/backend.ts:252`; the CLI `record`/`explore` verbs in `src/app/cli-record.ts`

## Connected to

- **owns:** the journal, its [[explore-run]]
- **owned-by:** [[backend]]; [[agent-session]] (the agent drives one)
- **joins:** [[session]], [[flow]] (same runner), [[recording]] (`save`), [[approval]], [[card]], [[guard]], the desktop (`src/desktop/types.ts:53`)
- **looks-like-but-is-not:** the MCP server (`src/mcp/server.ts`, leftover)

## If you change this

- **Hits:** `src/browser/browsers.ts` (reads the info file), `.claude/skills/autobrowse/scripts/state.sh` (held sessions), `src/agent/explorer.ts`, `test/layout.test.ts` (the `text` layout), `src/agent/sessions.ts`, `src/app/cli-record.ts`, `src/app/backend.ts:252`, `.claude/skills/autobrowse/explore.md` and the skill's scripts (the command list is documented there), `src/mcp/server.ts`.
- **Does not hit:** compiled workflows already rendered; the run object.

## Surfaces

| Surface | Role |
|---|---|
| Claude Code skill scripts, `autobrowse explore` | send commands |
| agent | sends commands |

## See

- Source: `src/explore/server.ts`
- Skill: `.claude/skills/autobrowse/SKILL.md` (router), `explore.md` (the commands)
