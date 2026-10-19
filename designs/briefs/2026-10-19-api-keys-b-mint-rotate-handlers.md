# Brief B: API keys: the Console flow writes a key, rotation, handlers for wren

Bead wa-sos.2 (part B of two). Design: `designs/2026-10-19-api-keys-as-accounts.md`. Builds on part A (`designs/briefs/2026-10-19-api-keys-a-vault-ring-cli.md`, its commit is on the branch you start from): `keyStoreFor`/`keysFor(settings)`, `projectKeysFor(settings)`, `src/app/cli-keys.ts`, the vault source in `src/reach/`. Read A's diff first (`git log -p` of its commit). credvault 0.13.0 is linked the same way as in A (local symlink, not committed).

## Build

### 1. The Console flow writes a key credential (`src/workflows/anthropic-console-api-key/`)

- Plan: `{ dryRun, name, account?, purposes?: string[], replaces?: string }`. `keepAs` goes away. `name` is the key's name in the Console (`vendorId`). `account` defaults to `name` (it must pass the credvault account rule; say so in `.describe`). `replaces` is an address (`anthropic@<account>`) for a rotation.
- Deps: `keys: KeyKeeper` in place of `sink`, where `KeyKeeper = { put(key: ApiKeyInput): Promise<ApiKey>; get(address): Promise<ApiKey | null>; project(vendors: string[]): Promise<{ put: string[]; removed: string[] }>; owner: string; login(site: string): Promise<string> }`. `login("anthropic")` answers the stored credential key the browser signs in with (`credentialsFor(settings).keyOf("anthropic")`), so `via` names the real login. Build it once in `services.ts` (`keyKeeperFor(settings)`) and give it to the workflow deps where `sink` is given today (`src/app/backend.ts` and wherever compiled/hand-written workflow deps are built). If a flow can run under another login (`anthropic@<role>`; check `defineFlow`/`BrowserFlow.site`), add `login?: string` to the plan; if not, the main login is the only one and the brief's `via` is its key.
- After `keyWorks` passes, the flow writes `{ site: "anthropic", account, owner: keys.owner, secret, via, vendorId: name, purposes, madeAt: now }`, then `keys.project(["anthropic"])`. The key still never reaches the journal or a step result. The step's `done` text names the address, the id and the env names the projection set.
- Rotation (`replaces` set): the old key must exist and be the same vendor and owner (checked before the browser opens). The new key goes to the same address, keeps the old one's purposes, `via` and `cap`, and gets `previous: [{ id: old id, vendorId: old vendorId, revokedAt: now }, ...old.previous]`. Then the projection. The old key is not revoked at the vendor (no Console delete flow exists yet): the `done` text says `revoke "<old vendorId>" at <keys page> by hand`.
- Update `index.test.ts`: a memory `KeyKeeper` (credvault `memoryKeys` + `memoryEnvStore`); new key, rotation, refused proof keeps nothing, a rotation of a missing or other-vendor address stops before the browser.
- Callers that passed `keepAs` (README, docs, any plan in the repo): drop it.

### 2. `creds key rotate <address> [--clipboard]` (in `src/app/cli-keys.ts`)

- A vendor with a mint flow (a small table: `ROTATORS = { anthropic: { workflow: "anthropic-console-api-key", plan: (key) => ({ name: \`${key.account}-${yyyymmdd}\`, account: key.account, replaces: address }) } }`): starts that run the way `autobrowse run` does (`api.run(workflow, key).run(plan)`, run key `rotate-<account>-<yyyymmdd>`), prints the run and `autobrowse status …`. The run's own gate asks before the key is made.
- `--clipboard` (or a vendor with no flow): the new value by hand (clipboard, stdin or prompt, as `creds key add`); same `previous`/purposes/projection rules as the flow's rotation, done in one shared function both use (`rotateKey(store, address, newSecret, o)` in a module both import, e.g. `src/auth/keys.ts`). Prints `revoke the old key at <vendor> by hand`.
- A vendor with no flow and no `--clipboard`: refuse with the `--clipboard` command to run.

### 3. Handlers on the `sites` service (`src/sites/service.ts`), for wren's Accounts page

Every handler answers with no secret. Inputs parsed with zod; a bad input is a `TerminalError` 400, an unknown address 404, a vendor with no flow 501. Reads use `READ_RETRY`, writes `WRITE_RETRY`, each inside one `ctx.run`.

| handler | input | answer |
|---|---|---|
| `keys` | `{ vendor?: string; all?: boolean }` | `{ keys: KeyRow[] }`, revoked only with `all` |
| `keySpend` | `{ address: string; until?: string }` | `KeyRow` |
| `keyRevoke` | `{ address: string }` | `{ key: KeyRow; projected: { put: string[]; removed: string[] } }` |
| `keyRotate` | `{ address: string }` | `{ run: string; workflow: string }` (starts the rotator's run, as the CLI does); 501 with no flow |

`KeyRow` = credvault `KeyInfo` plus `uses: number` and `lastUsedAt: string | null` from this process's audit (`keyUses` over `recent(10_000)`). Export the `KeyRow` type and the four request/answer shapes from one module (`src/sites/keys.ts`), and list them in README's "Restate services" part: wren copies them by hand (it imports nothing from this repo).

The handlers go through the facade (or a `keys` dep beside it, whichever matches how `renew`/`revoke` reach their deps). The desk (`src/app/desk.ts`) serves the same service: wren calls `keyRotate` on `desk` (the Console needs the Mac's signed-in browser) and the other three on `sites`.

### 4. Docs and map

README: the Console flow line (writes a key credential, no `keepAs`), `creds key rotate`, the four handlers. `map/objects/sites/token.md` or `map/objects/auth/credential.md` (whichever A did not already cover) names the handlers; `map/effects/CONTEXT.md` gains a row: "the `keys` handlers' shapes → wren `packages/core` Accounts rows (copied types)". Bump `verified`.

## Tests (synthetic keys only)

- service handlers over memory stores: list hides secrets (assert on `JSON.stringify`), spend, revoke re-projects, rotate on a vendor with no flow is 501, unknown address 404.
- `rotateKey`: purposes, via and cap carried, `previous` grows, projection follows, old id gone from the env names.

## Rules

- Worktree: continue in `~/worktrees/autobrowse-keys` on branch `wa-sos-2-keys` (part A's commit is there). The link stays.
- While building: `pnpm exec vitest run <file>`. Hand-off: `pnpm -s gates` once.
- Never print a key value, read or source an env file, or run a command whose text contains ".env". The repo is public.
- Commit only your paths: `git commit -q -F <msgfile> -- <paths>`, with the planner's trailers. No push.
