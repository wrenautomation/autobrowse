---
type: object
cluster: app
universe: live
status: verified
verified: 2026-09-30 @ d2b9ec7+
entity: src/owner.ts
---

# Owner

A tenant: its own accounts, files, SSM path, Keychain item and Restate names. `AUTOBROWSE_OWNER` or `--owner <name>` picks it; the default, `wren`, keeps every name from before owners existed.

## Why this shape

One process serves one owner, so isolation is decided once at startup (`boot`), not checked on every read. Accounts are the owner's; tools (LLM, search, AWS, the box) are the operator's. An owner's paths are fixed, so no owner's env can point at another's file. Why: `designs/2026-09-30-owner-keys.md`.

## Shape

- `DEFAULT_OWNER`, `isDefaultOwner`, `named` (Restate `<base>_<owner>`), `ownerKeys` (SSM `/autobrowse/owners/<o>/config`, S3 `owners/<o>/`, `inputs/owners/<o>/`) — `src/owner.ts:11-29`
- `awsConfig`: the default owner uses the process's credentials, any other the owners role tagged `owner=<o>`, else it throws — `src/owner.ts:44`; `awsFor(settings)`, the only AWS client factory — `src/app/owner.ts:169`
- Setting classes: `OWNER_SETTINGS`, `PROCESS_SETTINGS`, `OPERATOR_TOOL_KEYS`; everything else is the operator's — `src/app/owner.ts:27-63`
- `enterOwner` drops the operator's accounts from the env, then reads `<ownersDir>/<o>/.env`; a key that is the operator's or a fixed path throws — `src/app/owner.ts:130`; `boot()`, every entry point's first line — `:162`; `ownerFromArgv` — `:175`
- Files: `OWNER_PATHS`, `ownerDir` — `src/app/config.ts:434`, `:455`; Keychain `autobrowse-owner-<o>` (`keychainOf`) — `src/auth/keep.ts:14`
- AWS side: role `autobrowse-prod-owners`, session tag `owner` scopes SSM and S3 — `deploy/terraform/owners.tf:43`

Citations: `src/owner.ts:11`, `src/app/owner.ts:130`, `src/app/config.ts:434`, `src/auth/keep.ts:14`, `deploy/terraform/owners.tf:43`

## Connected to

- **owns:** an owner's [[state-files]] (under `owners/<o>/`), its [[credential]]s, [[account]]s, [[access-key]]s and done [[need]]s
- **owned-by:** the process (one owner each)
- **joins:** [[settings]] (`owner`, `ownerRoleArn`, `ownersDir`), [[runs-registry]] (`Runs_<o>`), [[token]] (the owner's SSM path)
- **looks-like-but-is-not:** a card's `owner` (who a card belongs to, `src/money/profile.ts`); the access scope `operator` (the UI token that does everything, `src/access/keys.ts:41`)

## If you change this

- **Hits:** every `*For(settings)` in `src/app/services.ts` that names a file, SSM path or AWS client; Restate service names (wren calls the default names); `deploy/terraform/owners.tf` (the tag the policy trusts); credvault `ownerCredentials`.
- **Does not hit:** the default owner's names: `wren` keeps `/autobrowse/config`, `autobrowse` Keychain, `Runs`.

## Surfaces

| Surface | Role |
|---|---|
| CLI `--owner`, `AUTOBROWSE_OWNER` | pick |
| `<ownersDir>/<o>/.env` | write (the owner's accounts only) |
| the worker, desk | read (once, at boot) |

## See

- Source: `src/owner.ts`, `src/app/owner.ts`
- Design: `designs/2026-09-30-owner-keys.md`
