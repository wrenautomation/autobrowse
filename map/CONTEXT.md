# How to walk this map

Open `CLAUDE.md`, find the noun in `objects/_index.md`, open its card. A card is one hop from source: its `See` line is a file path. Do not read `objects/` whole; the index exists so you never have to.

## Clusters (by how an editor asks, not by folder)

| Cluster | Question it answers | Source dirs |
|---|---|---|
| `runs` | how a workflow runs on Restate, gates, events, the registry | `src/engine/` |
| `browser` | how a page is opened, acted on, repaired, watched, walked | `src/browser/` |
| `auth` | credentials, sign-ins, providers, codes, accounts, what is owed | `src/auth/`, `src/app/needs.ts`, `credvault` |
| `sites` | official site APIs, the facade, tokens and their renewal | `src/sites/` |
| `build` | explore → recording → outline → compiled workflow → proof; the agent | `src/explore/`, `src/recorder/`, `src/compiler/`, `src/agent/`, `src/workflows/` |
| `money` | the payment gate, spend policy, wallet, charges | `src/gates/`, `src/money/` |
| `access` | agent keys, channels, the `do` verb and its abilities | `src/access/`, `src/channels/`, `src/do/` |
| `app` | settings, composition, the backend port, files on disk | `src/app/`, `src/ui/`, `~/.config/autobrowse` |

## Universes

- **live**: implement and cite against it.
- **leftover**: `src/mcp/server.ts` (MCP over stdio; the Claude Code skill in `.claude/skills/autobrowse` is the live path), `src/workflows/example-title/` (compiled 2026-09-20 as a demo; no site route or ability names it).
- **ghost**: none found at 70aefc3. `SITES` in `src/browser/flow.ts:63` (three profile home pages) is live but small; the login specs in `src/auth/sites.ts` are the real list.

## What the map is not

Not a second spec. `README.md` says what the product does; `designs/` says why. A card says what a noun is, where it lives, and what moves when it changes. Behaviour that lives in a file is pointed at, never copied.

## Outside the tree

Things that point into this repo and break silently are listed in `effects/CONTEXT.md` under "Pointing in". Add to it when you find one.
