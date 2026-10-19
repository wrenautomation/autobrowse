# API keys as accounts

2026-10-19. William: "im assuming autobrowse supports account based / multiple api keys managed just like it does with platform accounts? if not thats a gap that should be filled."

It does not. This doc closes the gap. One planner (Opus), Sonnet builders. Spans credvault, autobrowse and wren; autobrowse is home.

## Today

- A credvault credential is a login: username, password, TOTP, passkeys, `via`, `roles` (`credvault/src/credentials.ts`). An account is `site@role` or `site@username` (`autobrowse/src/auth/roles.ts`). No field for an API key.
- API keys sit in the flat env store: one SecureString per name under `/autobrowse/config` or `/autobrowse/owners/<owner>/config` (`envStoreFor`, `src/app/services.ts`). No vendor, account, owner or purpose on a key. `env ls` shows names only.
- Two key rings, both by name: autobrowse Exa (`src/reach/key-ring.ts`: `EXA_API_KEY`, `EXA_API_KEY_1..n`, `NUM_EXA`; first live key, a 402 marks it spent to month end) and wren LLM fleets (`packages/llm/src/client.ts` `fleetKeys`, same names). Operator only.
- wren client keys: one sealed key per client per vendor (`client_secrets` unique on client+name where live; `vendor_modes` unique on client+vendor). The resolver `vendorKey()` picks own or managed, never by account.
- The Console flow `anthropic-console-api-key` mints a key and drops it under an env name (`keepAs`). It records no link to the Console login it came from, no key id, no owner.
- Audit: autobrowse audits per login credential (hash chained `audit.jsonl`); wren per key read (`client_secret_events`). Nothing audits which API key a call ran on.

## Target

An API key is a credential. It belongs to an account, has an owner, a vendor, a label and a purpose, and every use is audited. A call names the account it runs on, the way a browser flow names `site@role` today. Several keys per vendor per owner are normal; the ring is derived from them, not from env names.

### Model (credvault)

New credential kind `key`, in the same vault, same audit chain, same sync:

| field | meaning |
|---|---|
| `site` | the vendor: `anthropic`, `exa`, `cohere`, `openrouter`, `twilio`, ... |
| `account` | the label: `autobrowse-prod`, `william-console`, `client-ccl`. The address is `site@account`, as for logins |
| `owner` | who it belongs to: `wren` (operator) or an owner id (`do_careerclaritylabs`) |
| `secret` | the key |
| `via` | the login credential it was minted from (`anthropic@william`), so rotation knows where to go |
| `purposes` | `default`, `bulk`, `drafts`, ... one key per purpose per vendor per owner, like `pays`/`signup` on addresses |
| `status` | `live`, `spent` (until a date), `revoked` |
| `madeAt`, `lastUsedAt`, `uses` | for audit and for "which key is this" |
| `cap` | optional monthly cap in micros or units; a use past it marks the key spent |

Key ids are the hash fingerprint already used by `key-ring.ts`, so a log line names a key without printing it.

### Selection

- `keysFor(owner, vendor, purpose?)`: the live keys of that vendor for that owner, the purpose's key first, then `default`, then the rest by `madeAt`. This is the ring. `key-ring.ts` keeps its spent logic and reads this list instead of env names.
- A call that names an account (`--account anthropic@autobrowse-prod`, or `account` in a plan) runs on that key only, no fallback. Unnamed: the ring.
- Owner isolation holds as for logins: an owner's call never sees the operator's keys unless the vendor is in `OPERATOR_TOOL_KEYS` (today's rule, unchanged).

### Env projection (compatibility)

Processes that read env keep working. `env pull` and the box's deploy materialize, per vendor, `<VENDOR>_API_KEY` from the `default` key and `<VENDOR>_API_KEY_1..n` plus `NUM_<VENDOR>` from the rest. wren's `fleetKeys` and `WREN_ANTHROPIC_API_KEY` need no change on day one. The projection is one way: the vault is the source, env is a view. `env set NAME` for a name shaped like a vendor key is refused with the `creds key add` command to run instead.

### Minting and rotation

- `anthropic-console-api-key` (and any later vendor flow) writes a `key` credential: `site` the vendor, `account` the plan's name, `via` the login it signed in with, `owner` from the process. `keepAs` goes away; the projection names the env.
- `creds key rotate site@account`: re-runs the vendor's flow via the `via` login, stores the new key, marks the old `revoked` (and revokes it at the vendor where a flow exists), re-projects env.
- `creds key add site@account --clipboard` for a key made by hand (a vendor with no flow). `creds key ls` prints addresses, owner, purposes, status, last use, never values. `creds key spend site@account` marks spent by hand.

### Audit

Every read of a key by a call writes a `SecretUse` (existing type) with the key id, caller, reason and owner into the same chained audit. `creds audit site@account` lists uses. wren's `vendor_usage` rows gain the key id, so Numbers can show spend per key and per account, and the Anthropic $200/mo credit can be watched per key.

### wren

- `client_secrets` unique becomes (client, vendor, label) where live. `vendor_modes` gains `key` (a label) so a client holds several keys per vendor and picks one per purpose. `vendorKey()` resolves by (client, vendor, purpose) with the same no-fallback rule for own mode.
- Wren's own keys (managed mode) come from the projection, so the operator vault is the single source. `WREN_KEYS` entries that point at env names keep working.
- The Accounts page (accounts first class, 2026-10-15) lists API keys beside logins: address, owner, purposes, status, spend this month. Rotate and revoke buttons call the CLI's paths through the console.

## Not in scope

- Per-call key choice in wren's portal UI beyond the Accounts page.
- Moving the Exa ring's spent state out of memory (today's behavior stays).
- Vendors without a Console flow get `creds key add` only.

## Order

1. credvault: `key` kind, `keysFor`, projection, audit uses, CLI (`creds key add|ls|spend|rotate|audit`). Migration: every `<VENDOR>_API_KEY[_n]` in the env store becomes a `key` credential (owner `wren`, account `env-<n>`, purpose `default` for the bare name) and is re-projected unchanged. Verify the projection equals the store before and after.
2. autobrowse: `key-ring.ts` reads `keysFor`; `--account` on vendor calls; the Console flow writes a credential and drops `keepAs`; `env set` refuses vendor key names.
3. wren: schema change, resolver by purpose, key id on `vendor_usage`, Accounts page rows. Lands after 1 and 2 are on npm (autobrowse) and pulled.

## Decisions

- The vault is the source, env is a projection. Why: two sources drift, and the Explore run that found this gap also found a key value in a local env file read.
- Keys are credentials, not a new store. Why: audit chain, SSM sync, owner isolation and the Accounts page all exist for credentials already.
- No fallback when an account is named. Why: same rule as wren's own-key mode; a quiet fallback to the operator's key is a billing and data leak.

## Decisions (planner, 2026-10-19)

- credvault is a library with no CLI. `creds key …` and `creds key migrate` live in autobrowse; credvault gives the pieces. Briefs: `credvault/designs/briefs/2026-10-19-api-keys.md`, `autobrowse/designs/briefs/2026-10-19-api-keys-{a,b}-*.md`, `wren/designs/briefs/2026-10-19-api-keys-w{1,2}-*.md`.
- A key is its own schema (`apiKeySchema`), not a login with optional fields. Why: `Credential.username` is read in many places; a union would touch every sign-in path for no gain.
- Keys are stored one JSON row per key in an `EnvStore` at `<owner path>/keys` (SSM, one level below the env names). `env ls` and the box's deploy never see the rows. SSM's own 100 versions are the key's history.
- No local copy of the key rows. The env projection is the offline fallback: the ring reads the vault and falls back to the projected env names when the vault has no key or does not answer.
- `lastUsedAt` and `uses` come from the audit, not from the key row. Why: a row write per API call is an SSM write per call. They count per machine (the box's and the Mac's audits differ).
- `owner` lives in the row and must equal the store's owner. An owner's process reads its own vault only; an operator vendor (`OPERATOR_TOOL_KEYS`) reaches it through the env, as today. Why: an owner's AWS session cannot read the operator path, and should not.
- The projection carries `live` and `spent` keys, not `revoked`. Why: env readers have their own spent logic, and nobody re-projects when a spent key's date passes.
- The projection is written into the env store (and, on a Mac, the local env file through the synced sink) on every key write. `env pull` and the box's deploy then read it unchanged.
- Migration: the bare name is `env-0` with purpose `default`; `_<n>` is `env-<n>`. One `madeAt` for all, so the ring orders the rest by account and reproduces `_1..n`. Checked on prod 2026-10-19 by fingerprint: `EXA_API_KEY`, `_1`, `_2` are three different keys, so the rule reproduces the store.
- Rotation keeps the address. The new secret replaces the old in the row; the old id goes to `previous` with `revokedAt`. No vendor revoke flow exists yet (no Console delete recording): rotation says "revoke it by hand". A vendor without a mint flow rotates with `--clipboard`.
- `creds key revoke` and `creds key purpose` are added: the Accounts page's revoke button and the one-purpose-per-key rule need them.
- Cap: `calls` caps are enforced per machine by the ring (a monthly counter file beside `spent-keys.json`). `micros` caps are stored and shown, not enforced: the ring does not know a call's cost.
- `--account` reaches the Exa ring (the `web` site and `autobrowse web`). Other single-key vendors keep reading their env name, which the projection keeps equal to the vault.
- wren: `client_secrets` unique is `(client, name, label)`, not `(client, vendor, label)`: one vendor has two names (Stripe's secret key and webhook secret). `vendor_modes` gains `purpose`; its `key_name` ref already picks one key, so no label column there.
- wren: `vendor_usage.key_id` is set where wren holds the value (own keys, env-held managed keys). Calls whose key a path holds (autobrowse's Exa ring, the gateway) keep null.
- wren: the operator's keys are mirrored into `vault_keys` from autobrowse `sites/keys`, hourly and after each action. Why: the Accounts page makes no vendor call on load.
- wren's own env is not a projection target yet. `WREN_KEYS` entries that name an env name keep reading wren's env. Making wren's deploy read the vault is a later step (the `/wren/prod/env` cap makes it a deploy change of its own).
