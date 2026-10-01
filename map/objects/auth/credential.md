---
type: object
cluster: auth
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/auth/keep.ts
---

# Credential

A stored sign-in for a site: `Credential` and `CredentialStore` come from the `credvault` package; autobrowse owns only its names in it (`src/auth/keep.ts`).

## Why this shape

The vault is its own repo and npm package (public). Changing a name in `src/auth/keep.ts` strands what is already stored under the old one (`src/auth/keep.ts:1-6`).

## Shape

- Names: Keychain service `autobrowse` (seal key; an owner's `autobrowse-owner-<owner>`), env prefix `AUTOBROWSE_CRED_`, secret prefix `AUTOBROWSE_` — `src/auth/keep.ts:9-20`; SSM path `/autobrowse/config` (an owner's `/autobrowse/owners/<owner>/config`) — `src/owner.ts:20-29`
- Store: env layer first, then the sealed file `~/.config/autobrowse/credentials.json` (`src/app/config.ts:221`); armed with a canary whose read is refused and reported — `src/app/services.ts:424-476`
- A credential is keyed `<site>` or `<site>@<label>`; `via` names an identity provider instead of a password (`methodsOf`, `src/auth/login.ts:630`)
- Minted on signup: `accountKey`, `mintCredential`, `mintPassword` — `src/auth/signup.ts:225-313`
- Every typed secret is audited (`SecretAudit`, `auditFor` `src/app/services.ts:582`; window read by `ledgerSince` `src/auth/ledger.ts:18`)

## Connected to

- **owned-by:** credvault (the store); [[app]] (`App.credentials`)
- **joins:** [[site-login]] (`credential` name), [[sign-in-context]] (`cred`), [[account]] (`AccountRow` is the view), [[guard]] (bound to hosts), [[need]] (`kind: credential`)
- **looks-like-but-is-not:** [[token]] (site API keys in the env store), [[card]] (its own Keychain item `autobrowse-wallet`)

## If you change this

- **Hits:** `src/app/services.ts:424`, `src/auth/login.ts`, `src/auth/accounts.ts`, `src/auth/signup.ts`, `src/app/needs.ts`, `src/app/cli-auth.ts` (`creds`), the wren repo (reads the same SSM path through credvault).
- **Does not hit:** the wallet; site API tokens.

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse creds`, `accounts`, UI Accounts page | write (never shows values) |
| sign-ins | read |

## See

- Source: `src/auth/keep.ts`; the store: `node_modules/credvault`
- Design: `designs/2026-09-22-vault-split.md`
