---
type: object
cluster: access
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/access/keys.ts
---

# Access key

An API key another agent presents, carrying a scope: which sites and accounts, which workflows and tools, which verbs: `Scope`, `StoredKey`, `KeyStore` in `src/access/keys.ts`; refusals worded by `src/access/fence.ts`.

## Why this shape

The operator's UI token does everything; a key does only what its scope lists. Keys are stored hashed in `access.json`; the value is shown once. `do` seen through a key is the catalog cut to the scope, each leg checked (`Backend.doAs`, `src/app/backend.ts:136`).

## Shape

- `VERBS = do | run | sites | agent`; `scopeSchema { sites (site, site@label, site@*), workflows (prefix*), tools, can }`; `Scope` (the operator or rules), `OPERATOR` — `src/access/keys.ts:22-41`; `allowsSite` — `:53`
- `StoredKey { name, hash, createdAt … }`; `KeyStore { list, add, revoke, resolve }`; `KEY_NAME` — `:76-92`; file `~/.config/autobrowse/access.json` (`src/app/config.ts:136`)
- `refusal(scope, method, path, query, lookups)` — `src/access/fence.ts:28`; applied per request in the API — `src/ui/api.ts:233-239`

## Connected to

- **owned-by:** the key store
- **joins:** [[ability]] (`doAs`), [[site-api]], [[compiled-workflow]], the UI bearer (`src/ui/auth.ts`)
- **looks-like-but-is-not:** a site [[token]]; a [[credential]]

## If you change this

- **Hits:** `src/ui/api.ts:202-248`, `src/ui/auth.ts`, `src/app/backend.ts:136` (`doAs`), `src/app/cli-access.ts`.
- **Does not hit:** Restate handlers (the ingress has its own auth), sign-ins.

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse access` | mint, revoke |
| HTTP API | resolves per request |

## See

- Source: `src/access/keys.ts`, `src/access/fence.ts`
- Design: `designs/2026-09-27-agent-access.md`
