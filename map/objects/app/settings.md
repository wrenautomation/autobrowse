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

- `Settings = z.infer<typeof schema>` — `src/app/config.ts:298`; `ENV_KEYS` — `:300-409`; `loadSettings(env)` — `:411`; `loadEnvFile(from)` — `:514`
- Files it names: `credentialsFile`, `walletFile`, `accountsFile`, `accessFile`, `fixesFile`, `screensFile`, `capsFile`, `needsDoneFile` (`:40-243`), `artifactsDir`, `recordingsDir`, `profilesDir`; a non-default [[owner]]'s are fixed under `ownersDir` (`OWNER_PATHS`, `:428`)
- Restate shape: `planEndpoint` (listen, or tunnel to Restate Cloud) — `src/app/endpoint.ts:17-63`
- Where values come from: `.env` (local), the box's prod.env (outside git; never printed), SSM through credvault for secrets

## Connected to

- **owned-by:** the process
- **joins:** every `*For(settings)` in `src/app/services.ts`, [[state-files]], [[app]]
- **looks-like-but-is-not:** the env store of site tokens (`autobrowse env`, [[token]]); the UI's one live setting (`Screen`, `src/app/screen.ts:9`)

## If you change this

- **Hits:** `src/app/services.ts`, `src/app/main.ts`, `src/app/status.ts`, `compose.yml`, `deploy/compose.prod.yml`, `deploy/prod.env.example`, `README.md` (the env table), the box's `prod.env` (outside git).
- **Does not hit:** compiled workflows (they take deps, not settings).

## Surfaces

| Surface | Role |
|---|---|
| `.env`, compose, the box | write |
| `autobrowse status`, UI `/api/settings` | read |

## See

- Source: `src/app/config.ts`
