# 0 · Setup

**Goal:** `autobrowse` runs on your machine at the tier you pick.

| Tier | Needs | Gives |
|------|-------|-------|
| 0 | Node 24+, Chromium | explore a public page, `compile --no-llm`, `try` |
| 1 | + a Claude Code subscription or one API key, your accounts | the agent, `do`, signed-in sites, 2FA and codes |
| 2 | + a local Restate | durable runs that survive restarts |

AWS is never needed for tiers 0 to 2.

## Tier 0: five minutes, no keys

```sh
npm i @wrenautomation/autobrowse && npx playwright install chromium   # in your project folder
npx autobrowse explore scratch --url https://example.com --background   # one browser, waiting for commands
npx autobrowse cmd '{"cmd":"aria"}'                                     # the page as controls
npx autobrowse cmd '{"cmd":"click","hints":{"role":"link","nth":0}}'
npx autobrowse cmd '{"cmd":"read","hints":{"role":"paragraph","nth":0},"as":"text"}'
npx autobrowse cmd '{"cmd":"save","name":"first-flow"}'                 # the journal becomes a recording
npx autobrowse cmd '{"cmd":"close"}'
npx autobrowse compile first-flow --no-llm                              # recording to code, no model
npx autobrowse try first-flow                                           # run it
```

That opens example.com, follows its link, reads a paragraph, compiles the
acts to a flow and runs it. No model, nothing signed in. The flow lands in
`~/.config/autobrowse/workflows/`. In a clone, `walkthrough/demos/03-explore.sh`
runs the same steps.

## Tier 1 and 2

```sh
npx autobrowse setup                    # asks the tier, then only what that tier needs
```

Tier 1 asks for the model (your Claude Code subscription when `claude` is on
the PATH, else an Anthropic key), the sites that sign in as you, and where
codes arrive. Tier 2 adds Restate:

```sh
brew install restatedev/tap/restate
restate-server                          # one terminal
npx autobrowse worker                   # another: Restate endpoint :9081, UI + API :9080
open http://localhost:9080              # runs, gates, explore, recordings, accounts, settings
```

Settings go to `.env` in the folder you run from (0600, never committed).
[`.env.example`](https://github.com/wrenautomation/autobrowse/blob/main/.env.example) lists every optional key by tier.

## From a clone

```sh
git clone https://github.com/wrenautomation/autobrowse && cd autobrowse
pnpm install && pnpm exec playwright install chromium
pnpm autobrowse --help                  # same CLI; `pnpm worker` runs the worker from source
pnpm gates                              # lint + typecheck + tests; the Restate test needs Docker
```

## Where things live

| Path | What |
|------|------|
| `~/.config/autobrowse/credentials.json` | sealed site credentials (`creds`) |
| `~/.config/autobrowse/audit.jsonl` | every secret use, allowed or refused |
| `~/.config/autobrowse/spend.jsonl` | every payment-gate decision |
| `~/.config/autobrowse/profiles/<site>[@account]` | one Chrome profile per identity |
| `~/.config/autobrowse/artifacts/` | screenshots, traces, `*.failure.json`, `*.aria.txt` |
| `recordings/` | journals from `record`, `explore`, `agent` |

## The one live setting

The header's `headed`/`headless` button in the UI (or `PUT /api/settings
{headless}`) decides how every browser from then on opens. `--headed` on a
single command overrides it once.

## What is still owed

`autobrowse needs` lists every login, key, consent, phone step, card and
decision autobrowse is waiting on, each with its command; rows clear
themselves once the thing is in hand. `needs do <id>` runs the ingestion.
