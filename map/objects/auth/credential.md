---
type: object
cluster: auth
universe: live
status: verified
verified: 2026-10-06 @ fb46b8e
entity: src/auth/keep.ts
---

# Credential

A stored sign-in for a site: `Credential` and `CredentialStore` come from the `credvault` package; autobrowse owns only its names in it (`src/auth/keep.ts`).

## Why this shape

The vault is its own repo and npm package (public). Changing a name in `src/auth/keep.ts` strands what is already stored under the old one (`src/auth/keep.ts:1-6`).

## Shape

- Names: Keychain service `autobrowse` (seal key; an owner's `autobrowse-owner-<owner>`), env prefix `AUTOBROWSE_CRED_`, secret prefix `AUTOBROWSE_` — `src/auth/keep.ts:9-20`; SSM path `/autobrowse/config` (an owner's `/autobrowse/owners/<owner>/config`) — `src/owner.ts:20-29`
- Store: env layer first, then the sealed file `~/.config/autobrowse/credentials.json` (`src/app/config.ts:225`); armed with a canary whose read is refused and reported — `src/app/services.ts:440-492`
- A credential is keyed `<site>` or `<site>@<label>`; `via` names an identity provider instead of a password (`methodsOf`, `src/auth/login.ts:672`)
- Named by `<site>` (main or only), `<site>@<role>` or `<site>@<username>`: `resolveAccount` `src/auth/roles.ts:66`; `namedStore` `src/auth/roles.ts:120` wraps the store and names the browser profile (`profileName`, `src/browser/session.ts:135`); `giveRole`/`dropRole` `src/auth/roles.ts:160-201` behind `creds role` (`src/app/cli-auth.ts:542`)
- Minted on signup: `accountKey`, `mintCredential`, `mintPassword` — `src/auth/signup.ts:225-313`
- `creds link [logins...] [--keys] [--open] [--ttl]` (`src/app/cli-auth.ts:375`): `mintCredentialLink` (`src/auth/link.ts`) seals `{label, fields: [{name, value}]}` (stored logins and env keys) with AES-GCM, posts only the ciphertext to wren's phone Worker signed with `CRED_LINK_SECRET` (`credLinkUrl`, `credLinkSecret` in `src/app/config.ts`), and prints `<url>/c/<id>#<key>`; `--open` drops the sign-in for someone outside Wren; one audit line per login or key
- Every typed secret is audited (`SecretAudit`, `auditFor` `src/app/services.ts:620`; window read by `ledgerSince` `src/auth/ledger.ts:18`)

## Connected to

- **owned-by:** credvault (the store); [[app]] (`App.credentials`)
- **joins:** [[site-login]] (`credential` name), [[sign-in-context]] (`cred`), [[account]] (`AccountRow` is the view), [[guard]] (bound to hosts), [[need]] (`kind: credential`)
- **looks-like-but-is-not:** [[token]] (site API keys in the env store), [[card]] (its own Keychain item `autobrowse-wallet`)

## If you change this

- **Hits:** `src/app/services.ts:440`, `src/auth/link.ts` and wren `apps/phone` (the link's sealed shape), `src/auth/roles.ts`, `src/auth/login.ts`, `src/auth/accounts.ts`, `src/auth/signup.ts`, `src/app/needs.ts`, `src/app/cli-auth.ts` (`creds`), the wren repo (reads the same SSM path through credvault).
- **Does not hit:** the wallet; site API tokens.

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse creds`, `accounts`, UI Accounts page | write (never shows values) |
| `autobrowse creds link` → wren phone Worker | read, sealed for one reveal on the phone |
| sign-ins | read |

## See

- Source: `src/auth/keep.ts`; the store: `node_modules/credvault`
- Design: `designs/2026-09-22-vault-split.md`, `designs/2026-10-02-account-roles.md`, and the wren repo's credential-links design (2026-10-06)
