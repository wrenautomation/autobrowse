---
type: object
cluster: auth
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/auth/identities.ts
---

# Account

One of the person's addresses and what it is for: `Identity` in `src/auth/identities.ts`, kept in `accounts.json`; `autobrowse accounts`. What is stored per site is an `AccountRow` (`src/auth/accounts.ts`).

## Why this shape

Purposes decide which account a site call or consent runs as when nobody names one: `default`, `pays`, `signup` are held by one account each; any other word is a group (`sends`). A site names a purpose, a setup step can override it (`src/auth/identities.ts:21-36`, `src/sites/types.ts:165-170`).

## Shape

- `Identity { address, at: google|microsoft, for: string[], note? }` — `src/auth/identities.ts:40-48`; store `fileIdentities` / `envIdentities` (`AUTOBROWSE_ACCOUNTS` on the box) / `layeredIdentities` — `:151-178`; file `~/.config/autobrowse/accounts.json` (`src/app/config.ts:208`)
- `accountSite(nameOrAddress)`: a bare address is `google@<address>` — `:61`
- `AccountRow { site, known, ask, username, via, url, has{…} }`, `Accounts { list, save, check }` — `src/auth/accounts.ts:15-52`
- New accounts: `NewAccount`, `accountKey` (which credential name), `signupGoal` — `src/auth/signup.ts:193-336`; `lookForAccount` asks the site first — `src/auth/exists.ts:78`

## Connected to

- **owns:** purposes
- **owned-by:** [[app]] (`identitiesFor`, `src/app/services.ts:407`)
- **joins:** [[credential]] (the row is its view), [[site-facade]] (`accountFor`, `policyAccount` `src/sites/wire.ts:82-103`), [[need]] (`accountNeeds`), `Policy` (`src/app/owed.ts:42`)
- **looks-like-but-is-not:** `Identity` in `src/browser/identity.ts:16` (the browser's UA); an access key

## If you change this

- **Hits:** `src/sites/wire.ts`, `src/sites/renew.ts`, `src/app/needs.ts:172`, `src/app/owed.ts`, `src/app/cli-accounts.ts`, `src/app/cli-auth.ts`, UI `/api/accounts`, `/api/policy` (`src/ui/api.ts:245-309`).
- **Does not hit:** the runner; the vault format.

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse accounts`, UI Accounts | write |
| site facade, needs | read |

## See

- Source: `src/auth/identities.ts`, `src/auth/accounts.ts`
