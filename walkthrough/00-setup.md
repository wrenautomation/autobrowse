# 0 · Setup

**Goal:** `pnpm autobrowse` works on this Mac; the worker + UI run locally.

## Install

```sh
brew install node pnpm            # Node 24+, pnpm 10
cd ~/Documents/wren_automation/autobrowse
pnpm install
pnpm exec playwright install chromium   # the browser the flows drive (BROWSER_CHANNEL=chrome uses your Chrome instead)
cp .env.example .env               # every key explained inline; start with LLM_* and NOTIFY_*
pnpm autobrowse --help
```

`.env` is 0600 and gitignored. Values never go in commits; `autobrowse env`
moves them between machines (guide 1).

## Sanity

```sh
pnpm autobrowse site                # sites, token state, setup left
pnpm autobrowse abilities           # everything `do` can route to, and what is not recorded
pnpm gates                          # lint + typecheck + tests; the Restate test needs Docker
```

You should see the site table (guide 2) and a green gates run.

## The worker and UI

```sh
pnpm ui:build
pnpm worker                         # Restate endpoint :9081, UI + API :9080
open http://localhost:9080          # runs, gates, explore, recordings, accounts, settings
```

Without a Restate server the worker still serves the UI and every
non-durable command (`explore`, `agent`, `try`, `site call`). For durable
runs (`run`, `domain`) start one:

```sh
docker compose up -d --build        # Restate + worker in containers, .env supplies secrets
```

## Where things live

| Path | What |
|------|------|
| `~/.config/autobrowse/credentials.json` | sealed site credentials (`creds`) |
| `~/.config/autobrowse/audit.jsonl` | every secret use, allowed or refused |
| `~/.config/autobrowse/spend.jsonl` | every payment-gate decision |
| `~/.config/autobrowse/profiles/<site>[@account]` | one Chrome profile per identity |
| `~/.config/autobrowse/artifacts/` | screenshots, traces, `*.failure.json`, `*.aria.txt` |
| `recordings/` | journals from `record`, `explore`, `agent` (gitignored) |
| `src/workflows/<name>/` | compiled workflows with `outline.json` |

## The one live setting

The header's `headed`/`headless` button in the UI (or `PUT /api/settings
{headless}`) decides how every browser from then on opens. `--headed` on a
single command overrides it once.
