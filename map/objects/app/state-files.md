---
type: object
cluster: app
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/app/config.ts
---

# State on disk

What autobrowse keeps outside git, where, and which card owns it. Defaults from `src/app/config.ts`; the box uses the same names under its data volume.

## Why this shape

Plain files a person can open, one concern each; secrets sealed; shared truth in SSM. Nothing here is generated from anything else, so a wrong move strands state.

## Shape

| Path | Holds | Card |
|---|---|---|
| `~/.config/autobrowse/credentials.json` | sealed sign-ins (`src/app/config.ts:180`) | [[credential]] |
| `~/.config/autobrowse/wallet.sealed` | sealed cards (`:182`) | [[card]] |
| `~/.config/autobrowse/accounts.json` | identities and purposes (`:202`) | [[account]] |
| `~/.config/autobrowse/access.json` | hashed agent keys (`:95`) | [[access-key]] |
| `~/.config/autobrowse/fixes.json` | kept repairs (`:73`) | [[fix]] |
| `~/.config/autobrowse/screens.json` | learned screens (`:75`) | [[screen]] |
| `~/.config/autobrowse/steps.jsonl` | agent step ledger (`src/agent/ledger.ts`) | [[agent-session]] |
| `~/.config/autobrowse/needs-done.json` | decisions marked done (`src/app/owed.ts:79`) | [[need]] |
| `~/.config/autobrowse/profiles/<site>` | browser profiles | [[session]] |
| `~/.config/autobrowse/artifacts/` | shots, aria, traces, `*.failure.json`, watched steps (`src/app/services.ts:477`) | [[failure-record]], [[watch-step]] |
| `recordings/` (repo, gitignored) | recordings, explore journals | [[recording]], [[explore-session]] |
| `src/workflows/<name>/` (repo, committed) | compiled modules, outline, proof | [[compiled-workflow]] |
| SSM `/autobrowse/config` | site tokens, env store (credvault `EnvStore`) | [[token]] |
| SSM `/wallet/cards`, `/wallet/profiles` | wallet backup (`src/money/wallet.ts:244`, `src/money/profile.ts:155`) | [[card]] |
| S3 shots bucket | shipped screenshots (`src/shots/ship.ts:109`) | — |
| Keychain `autobrowse`, `autobrowse-wallet` | seal keys (`src/auth/keep.ts:7-9`) | [[credential]], [[card]] |

Temp dirs `run-files-*`, `upload-*`, `passwords-*` are reaped (`src/browser/reap.ts:72`).

## Connected to

- **owned-by:** [[settings]] (names the paths)

## If you change this

- **Hits:** the card that owns the file; `src/app/config.ts`; `deploy/compose.prod.yml` volumes; `src/browser/reap.ts`.
- **Does not hit:** anything in git except `src/workflows/`.

## Surfaces

| Surface | Role |
|---|---|
| the worker, CLI | read, write |
| a person | may open the JSON files; never the sealed ones |

## See

- Source: `src/app/config.ts`
