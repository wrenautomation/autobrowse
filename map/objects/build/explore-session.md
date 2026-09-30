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

- `Command` (open, click, fill, place, keep, aria, read, note, save, os …) — `src/explore/server.ts:205`; `ExploreOptions` — `:302-373`; `Explorer` — `:400`
- Journal: `journalFileFor(recordingsDir, site, id)` under `recordings/.explore-<site>/` — `:376`; `readJournal` — `:380`; `DEFAULT_IDLE_MINUTES` 30 — `:394`
- Money and secrets on this path: `secrets`/`secretHosts` (place by name), `profiles` (a profile field, any host), `cards`, `cardsOnFile`, `charges`, `approve`, `audit` — `:317-357`; `placeHint` names the flag a missing secret needs — `:225-241`
- Help by hand, no pause: acts a person does between two commands count (`byHand`, `HAND_GRACE_MS` — `:243`, `:546-553`); the next answer carries `helped {acts, url, changed, note}` — `helpedSince` `:873`
- A target with no `frame` the page lacks is looked for in each visible iframe (`withFrame`, `src/browser/frames.ts`), so `place` on a card provider's hosted field (Braintree) works with plain role/name hints — `:891-895`
- Opened by `explorerOpener` — `src/app/backend.ts:246`; the CLI `record`/`explore` verbs in `src/app/cli-record.ts`

## Connected to

- **owns:** the journal
- **owned-by:** [[backend]]; [[agent-session]] (the agent drives one)
- **joins:** [[session]], [[flow]] (same runner), [[recording]] (`save`), [[approval]], [[card]], [[guard]], the desktop (`src/desktop/types.ts:53`)
- **looks-like-but-is-not:** the MCP server (`src/mcp/server.ts`, leftover)

## If you change this

- **Hits:** `src/agent/explorer.ts`, `src/agent/sessions.ts`, `src/app/cli-record.ts`, `src/app/backend.ts:246`, `.claude/skills/autobrowse/explore.md` and the skill's scripts (the command list is documented there), `src/mcp/server.ts`.
- **Does not hit:** compiled workflows already rendered; the run object.

## Surfaces

| Surface | Role |
|---|---|
| Claude Code skill scripts, `autobrowse explore` | send commands |
| agent | sends commands |

## See

- Source: `src/explore/server.ts`
- Skill: `.claude/skills/autobrowse/SKILL.md` (router), `explore.md` (the commands)
