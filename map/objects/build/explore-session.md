---
type: object
cluster: build
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/explore/server.ts
---

# Explore session

One open browser on a site, driven one JSON command at a time over loopback, every act journaled: `startExplore` / `Explorer` in `src/explore/server.ts`. Claude Code reaches it through `.claude/skills/autobrowse/scripts/`.

## Why this shape

A person or a model maps a page and acts on it; what works is journaled and becomes a recording, then a workflow. A session that dies keeps its journal file and resumes on its last page; idle sessions close themselves.

## Shape

- `Command` (open, click, fill, place, keep, aria, read, note, save, os …) — `src/explore/server.ts:198`; `ExploreOptions` — `:295-360`; `Explorer` — `:387`
- Journal: `journalFileFor(recordingsDir, site, id)` under `recordings/.explore-<site>/` — `:363`; `readJournal` — `:367`; `DEFAULT_IDLE_MINUTES` 30 — `:381`
- Money and secrets on this path: `secrets`/`secretHosts` (place by name), `cards`, `cardsOnFile`, `charges`, `approve`, `audit` — `:310-344`; `placeHint` names the flag a missing secret needs — `:218-234`
- Help by hand, no pause: acts a person does between two commands count (`byHand`, `HAND_GRACE_MS` — `:236`, `:533-540`); the next answer carries `helped {acts, url, changed, note}` — `helpedSince` `:834`
- Opened by `explorerOpener` — `src/app/backend.ts:243`; the CLI `record`/`explore` verbs in `src/app/cli-record.ts`

## Connected to

- **owns:** the journal
- **owned-by:** [[backend]]; [[agent-session]] (the agent drives one)
- **joins:** [[session]], [[flow]] (same runner), [[recording]] (`save`), [[approval]], [[card]], [[guard]], the desktop (`src/desktop/types.ts:53`)
- **looks-like-but-is-not:** the MCP server (`src/mcp/server.ts`, leftover)

## If you change this

- **Hits:** `src/agent/explorer.ts`, `src/agent/sessions.ts`, `src/app/cli-record.ts`, `src/app/backend.ts:243`, `.claude/skills/autobrowse/SKILL.md` and its scripts (the command list is documented there), `src/mcp/server.ts`.
- **Does not hit:** compiled workflows already rendered; the run object.

## Surfaces

| Surface | Role |
|---|---|
| Claude Code skill scripts, `autobrowse explore` | send commands |
| agent | sends commands |

## See

- Source: `src/explore/server.ts`
- Skill: `.claude/skills/autobrowse/SKILL.md`
