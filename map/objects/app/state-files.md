---
type: object
cluster: app
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/app/config.ts
---

# State on disk

What autobrowse keeps outside git, where, and which card owns it. Defaults from `src/app/config.ts`; the box uses the same names under its data volume. The rows are the default [[owner]]'s; any other owner's sit under `owners/<o>/`.

## Why this shape

Plain files a person can open, one concern each; secrets sealed; shared truth in SSM. Nothing here is generated from anything else, so a wrong move strands state.

## Shape

| Path | Holds | Card |
|---|---|---|
| `~/.config/autobrowse/credentials.json` | sealed sign-ins (`src/app/config.ts:225`) | [[credential]] |
| `~/.config/autobrowse/wallet.sealed` | sealed cards (`:223`) | [[card]] |
| `~/.config/autobrowse/accounts.json` | identities and purposes (`:243`) | [[account]] |
| `~/.config/autobrowse/access.json` | hashed agent keys (`:136`) | [[access-key]] |
| `~/.config/autobrowse/fixes.json` | kept repairs (`:112`) | [[fix]] |
| `~/.config/autobrowse/screens.json` | learned screens (`:114`) | [[screen]] |
| `~/.config/autobrowse/spent-keys.json` | paid keys out of credit, by sha256 fingerprint (never the value) → when they come back (1st of next month, UTC); beside the caps file (`src/reach/key-ring.ts`, `spentKeysFor` in `src/app/backend.ts`) | [[site-facade]] (`capsPerKey`), [[site-api]] (`web`'s Exa routes) |
| `~/.config/autobrowse/caps.json` | today's use of each account's daily caps, keyed site, account, bucket, and `next`: each site|account's next paced slot, kept across the day turning (`:116`; `/data/caps.json` on the box) | [[site-facade]] |
| `~/.config/autobrowse/steps.jsonl` | agent step ledger (`src/agent/ledger.ts`) | [[agent-session]] |
| `~/.config/autobrowse/runs/` | explore run history, one chained file a run, plus `index.jsonl` (`runsDirFor`, `src/app/services.ts:559`) | [[explore-run]] |
| `~/.config/autobrowse/walks/<site>/<name>.json` | walks built from runs (`walksDirFor`, `:524`) | [[walk-spec]] |
| `~/.config/autobrowse/llm/llm-YYYY-MM.jsonl` | every model call: purpose, tokens, ms (`llmCallsDirFor`, `:527`) | [[llm-call]] |
| `~/.config/autobrowse/needs-done.json` | decisions marked done (`src/app/config.ts:40`) | [[need]] |
| `~/.config/autobrowse/profiles/<site>` | browser profiles (`src/app/config.ts:86`) | [[session]] |
| `~/.config/autobrowse/artifacts/` | shots, aria, traces, `*.failure.json`, watched steps (`src/app/services.ts:516`) | [[failure-record]], [[watch-step]] |
| `~/.config/autobrowse/owners/<o>/` | a non-default owner's `.env` and the files above, fixed names (`OWNER_PATHS`, `src/app/config.ts:434`) | [[owner]] |
| `recordings/` (repo, gitignored) | recordings, explore journals | [[recording]], [[explore-session]] |
| `src/workflows/<name>/` (repo, committed) | compiled modules, outline, proof | [[compiled-workflow]] |
| SSM `/autobrowse/config` | site tokens, env store (credvault `EnvStore`) | [[token]] |
| SSM `/autobrowse/owners/<o>/config` | the same, for owner `<o>` (`src/owner.ts:25`) | [[owner]], [[token]] |
| SSM `/wallet/cards`, `/wallet/profiles` | wallet backup (`src/money/wallet.ts:244`, `src/money/profile.ts:184`) | [[card]] |
| S3 shots bucket | shipped screenshots (`src/shots/ship.ts:109`); owner `<o>` under `owners/<o>/` (`src/owner.ts:26`) | [[owner]] |
| Keychain `autobrowse`, `autobrowse-wallet` | seal keys (`src/auth/keep.ts:9-17`) | [[credential]], [[card]] |
| Keychain `autobrowse-owner-<o>` | owner `<o>`'s seal key (`src/auth/keep.ts:14`) | [[owner]] |

Temp dirs `run-files-*`, `upload-*`, `passwords-*` are reaped (`src/browser/reap.ts:72`).

## Connected to

- **owned-by:** [[settings]] (names the paths)

## If you change this

- **Hits:** the card that owns the file; `src/app/config.ts`; `src/browser/reap.ts`.
- **Does not hit:** anything in git except `src/workflows/`.

## Surfaces

| Surface | Role |
|---|---|
| the worker, CLI | read, write |
| a person | may open the JSON files; never the sealed ones |

## See

- Source: `src/app/config.ts`
