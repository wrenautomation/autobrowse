---
type: object
cluster: app
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/app/config.ts
---

# Settings

Everything the process reads from its environment, validated once: `Settings` from `loadSettings` in `src/app/config.ts`; `ENV_KEYS` maps each field to its variable name.

## Why this shape

One zod schema with defaults is the whole contract between the box, compose, `.env` and the code. Nothing else calls `process.env` for configuration; a name used twice is a bug.

## Shape

- `Settings = z.infer<typeof schema>` — `src/app/config.ts:302`; `ENV_KEYS` — `:300-409`; `loadSettings(env)` — `:411`; `loadEnvFile(from)` — `:514`
- Files it names: `credentialsFile`, `walletFile`, `accountsFile`, `accessFile`, `fixesFile`, `screensFile`, `capsFile`, `needsDoneFile` (`:40-243`), `artifactsDir`, `recordingsDir`, `profilesDir`; a non-default [[owner]]'s are fixed under `ownersDir` (`OWNER_PATHS`, `:428`)
- Restate shape: `planEndpoint` (listen, or tunnel to Restate Cloud) — `src/app/endpoint.ts:17-63`
- Where values come from, first wins: the process env, `~/.config/autobrowse/settings.json` (settings that are no secret, by field name; `src/app/settings-file.ts`, `SETTINGS_FILE`), the env file (secrets only; `boot` names a setting left there), the default. Secrets also sit in SSM through credvault
- `autobrowse settings [name] [--all]` shows each value and its source; `settings set|unset` checks the value as the boot does and notes it in `settings-changes.jsonl`; `env pull` sends settings to the file, secrets to the env file (`designs/2026-10-26-settings-file.md`)

## Connected to

- **owned-by:** the process
- **joins:** every `*For(settings)` in `src/app/services.ts`, [[state-files]], [[app]]
- **looks-like-but-is-not:** the env store of site tokens (`autobrowse env`, [[token]]); the UI's one live setting (`Display`, `src/app/display.ts:9`)

## If you change this

- **Hits:** `src/app/services.ts`, `src/app/main.ts`, `src/app/status.ts`, `compose.yml`, `deploy/prod.env.example`, `README.md` (the env table).
- **Does not hit:** compiled workflows (they take deps, not settings).

## Surfaces

| Surface | Role |
|---|---|
| `settings.json` (`autobrowse settings set`), the env file (secrets), compose | write |
| `autobrowse settings`, `autobrowse status`, UI `/api/settings` | read |

## See

- Source: `src/app/config.ts`
