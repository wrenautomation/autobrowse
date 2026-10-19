# Brief A: API keys in the vault: ring, `creds key` CLI, migration, env refusal

Bead wa-sos.2 (part A of two). Design: `designs/2026-10-19-api-keys-as-accounts.md`. credvault 0.13.0 (brief `credvault/designs/briefs/2026-10-19-api-keys.md`, built in `~/worktrees/credvault-keys`) gives `apiKeySchema`, `keyId`, `keyAddress`/`parseKeyAddress`, `KeyInfo`/`keyInfo`, `envKeys`, `memoryKeys`, `movePurposes`, `keysFor`, `liveAt`, `projectKeys`, `applyProjection`, `projectionDiff`, `parseVendorKeyName`, `isProjectedName`, `vendorBase`, `keysFromEnv`, `keyUses`, and `SecretUse.owner/keyId/reason`. Read its `src/keys.ts` before you start; its code is the contract (commit `0e7b4cb`). Notes from its build: `now` is epoch ms in `liveAt`/`keysFor`; `keysFromEnv` turns any `*_API_KEY[_n]` into a key, so filter the entries you pass; `projectKeys` throws on keys of several owners; `rowHash` skips undefined fields.

Part B (next brief, not yours): the Console flow, `creds key rotate`, and the Restate handlers wren calls. Leave `src/workflows/` and `src/sites/service.ts` alone.

## Local credvault link (not committed)

credvault 0.13.0 is not on npm yet. In your worktree, after `pnpm install`, point `node_modules/credvault` at the credvault worktree: `rm node_modules/credvault && ln -s ~/worktrees/credvault-keys node_modules/credvault` (its `dist` is built). Do not change `package.json` or `pnpm-lock.yaml`; the planner bumps them after the publish. Say in your report that the link was used.

## Build

### 1. Where keys live (`src/app/services.ts`)

- `keysFor(settings, ssm?)`: `envKeys(ssmEnvStore(ssm, ownerKeys(settings.owner).ssm + "/keys"))`, one per client and path for the process (same caching as `envStoreFor`). The rows sit one level below the env names: `env ls` and the box's deploy never see them. Name it `keyStoreFor` if `keysFor` collides with the credvault import.
- `projectKeysFor(settings)`: `(vendors: string[]) => applyProjection(sinkFor(settings), <every key in the store>, { vendors })`, returning the names put and removed. Every key write below calls it for that vendor: env is the vault's view (on a Mac the local env file gets the names too, through the synced sink).
- Owner rule: an owner's process reads only its own vault. A vendor in `OPERATOR_TOOL_KEYS` (by its `<BASE>_API_KEY` name) reaches an owner's process through the env, as today (`enterOwner` keeps those names). An owner's vault never holds an operator vendor: `creds key add` refuses it with that reason.

### 2. The ring reads the vault (`src/reach/key-ring.ts`)

- Import `keyId` from credvault and keep `fingerprint` as an alias of it.
- `RingKey` gains `address: string | null` (null for an env-only key) and `id` (= fingerprint).
- A key source: `type KeySource = (vendor: string, o: { account?: string; purpose?: string }) => Promise<RingKey[]>`.
- `vaultSource({ store, owner, env, ttlMs = 60_000, onError })` (in key-ring.ts or a sibling `src/reach/key-source.ts`):
  - `account` named: that key only (`get(address)`); its `site` must be the vendor and its `owner` the process's owner, and it must be `liveAt(now)`. Else throw `NoLiveKey` with a message that names the address and why (`no key exa@x`, `exa@x is spent until 2026-11-01`, `exa@x is revoked`). No fallback, ever.
  - Unnamed: `keysFor(store, { owner, vendor, purpose })`, cached `ttlMs` per (vendor, purpose). No vault key for the vendor, or the vault read failed (`onError` gets it once per ttl): the env ring (`ringKeys(BASE, env)`, today's names, which the projection keeps equal to the vault).
- `withKey(base, source, spent, send, o?)`: the source replaces `env`. Spent logic stays exactly as it is (402 → spent file until the 1st). New in `o`: `account`, `purpose`, `onUse(key: RingKey)` (called before each `send`), `uses?: KeyUses` (see cap), `now`. Keep a thin overload or helper so callers with only an env still work (`envSource(env)`), so the tests stay small.
- Cap, `unit: "calls"`: a monthly counter per key id in a JSON file next to `spent-keys.json` (`key-uses.json`, `{ id: { month: "2026-10", calls } }`, written like `fileSpent`). Before a send, a key whose count for this month reached `cap.amount` is marked spent until the 1st and skipped. `unit: "micros"` is stored and shown, not enforced here (the caller does not know the cost). A vault key carries its cap on `RingKey` (`cap?`).
- Every caller moves to a source: `src/reach/web.ts` (Exa), `src/sites/web.ts` legs, `src/sites/facade.ts` `capsPerKey`/`ringCount`, `src/app/cli-reach.ts`, `src/app/needs.ts` (the Exa need: held = vault keys, else env names). Wire one source per process in `services.ts`/`backend.ts` where `spent` is built today, as a `keys` dep beside `spent`.

### 3. Audit every use

`onUse` writes a `SecretUse` to `auditFor(settings)`: `{ at, credential: address ?? env name, field: "secret", site: vendor, url: endpoint without query, by: caller (the `by`/`caller` the call already carries, else the command name), owner, keyId, reason?: the route, allowed: true }`. A named account that is refused writes `allowed: false`. Never the value.

### 4. `--account` on vendor calls

- `autobrowse web …` commands (search, contents, answer, find-similar, research: whatever routes reach Exa today) take `--account <vendor@label>`.
- The `web` site's call input takes `account` (wren already sends `account` on `sites/call`; for the `web` site it now means the key's address). Thread it to `withKey`. A plan or a site call that names an account runs on that key only.

### 5. `autobrowse creds key …` (new file `src/app/cli-keys.ts`, registered under `creds` in `cli-auth.ts`)

Values never in argv, output or errors. Every write re-projects that vendor and prints the names it put or removed.

| command | does |
|---|---|
| `creds key add <vendor@label> [--clipboard] [--purpose p...] [--via login] [--vendor-id id] [--cap n --cap-unit calls\|micros]` | value from the clipboard, else piped stdin, else a hidden prompt (reuse `cli-env.ts`'s `cleanValue`/paste/prompt; export them if needed). Owner = the process's. Refuses an operator vendor in an owner's process. Refuses a value whose id another key already has (names that address) |
| `creds key ls [--vendor v] [--all]` | address, owner, purposes, status (with until), id, uses and last use (from `keyUses` over this machine's audit, `recent(10_000)`), via. Revoked only with `--all` |
| `creds key spend <address> [--until <date>]` | status `spent` until the date (default: the 1st of next month, UTC) |
| `creds key revoke <address>` | status `revoked`, `revokedAt` now; prints "revoke it at the vendor too" unless a flow does it (part B) |
| `creds key purpose <address> <purposes...>` | `movePurposes`: these purposes move to this key |
| `creds key audit <address> [-n 50]` | the audit lines for that key (address or id), newest last; no values |
| `creds key project [--check]` | re-project every vendor in the vault; `--check` prints `projectionDiff` (names and ids) and exits 1 when not empty |
| `creds key migrate [--apply]` | below |

### 6. Migration (`creds key migrate`)

Dry run unless `--apply`. Steps, each printed by name, address and id only:

1. The owner's env store: `list()`, then `getMany` of the key-shaped names only (`parseVendorKeyName`, `NUM_<BASE>`): a whole `all()` would decrypt every value. `keysFromEnv(entries, { owner, madeAt: now })`. Print every key it would make and every `skipped` with its reason.
2. Before: `projectionDiff(envStore, keys)` must be empty, else print it and stop (exit 1): the store is not a projection the vault can reproduce, and nothing is written.
3. A key whose id is already in the vault is skipped (re-runs are safe). An address held by a different id stops the run.
4. `--apply`: put each key, then `applyProjection` (it must put and remove nothing; print what it did), then `projectionDiff` again from the vault's own keys: must be empty. Print `migrated <n> keys for <vendors>; env equals the vault`.

Do not run `--apply` against prod. Run the dry run once against the real store at the end (it reads values into memory and prints names and ids only) and put its output (names, ids, counts) in your report. The planner runs `--apply`.

### 7. `env set` and `env rm` refuse projected names (`src/app/cli-env.ts`)

`isProjectedName(name)` → refuse: `<NAME> is an API key name: keys live in the vault. autobrowse creds key add <vendor>@<label> --clipboard`. `NUM_<BASE>`: `set by the projection from the vault's <vendor> keys`. `env get` and `env pull` still read them.

### 8. Docs and map

- README: the `creds key` commands, one line each, beside `creds`; the Exa ring line says the keys come from the vault.
- `map/objects/auth/credential.md`: a key is a credential kind; its rows; where `creds key` lives. `map/effects/CONTEXT.md`: the key-ring row names the vault and the projection. Bump `verified`. Run `map/_meta/rebuild.sh` if a card's frontmatter changed.
- `src/app/owner.ts` comment on `OPERATOR_TOOL_KEYS`: operator vendors reach owners through the env, never the owner's vault.

## Tests (synthetic keys only)

- key-ring: vault order wins over env; empty vault → env ring; vault error → env ring and `onError` once; named account: hit, wrong vendor, other owner, spent, revoked, missing (no fallback in each); 402 still marks spent and moves on; call cap reached → skipped and marked; `onUse` called per send.
- cli-keys over `memoryKeys` + `memoryEnvStore`: add (clipboard stub), clash, ls shows no value (assert on output), spend, revoke, purpose move, project --check exit code.
- migrate: round trip on a synthetic store with `X_API_KEY`, `X_API_KEY_1..2`, `NUM_X=2`, `Y_API_KEY`: dry run writes nothing; apply makes 4 keys, projection writes nothing, diff empty; second apply skips all; a store with a hand-edited `_2` that equals `_1` stops before writing.
- cli-env: `env set EXA_API_KEY` and `env set NUM_EXA` refuse with the command to run.

## Rules

- Worktree: `git -C /Users/williamjin/Documents/wren_automation/autobrowse worktree add ~/worktrees/autobrowse-keys -b wa-sos-2-keys main`, `pnpm install`, then the link above.
- While building: `pnpm exec vitest run <file>` for one test file. Hand-off: `pnpm -s gates` once (it takes the machine lock).
- Never print a key value, read or source an env file, or run a command whose text contains ".env". The repo is public: no client names, amounts or lead data.
- Commit only your paths: `git commit -q -F <msgfile> -- <paths>`, with the planner's trailers. No push.
