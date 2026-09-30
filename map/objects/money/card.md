---
type: object
cluster: money
universe: live
status: verified
verified: 2026-09-30 @ baab3e6+
entity: src/money/wallet.ts
---

# Card

A payment card in the wallet, placed into a checkout by field name after one yes per card and host: `Card` and `Wallet` in `src/money/wallet.ts`; the billing identity is a `Profile` (`src/money/profile.ts`); a charge that went through is a `Charge` (`src/money/charges.ts`).

## Why this shape

Cards never pass through a model or a log: `place{secret:"card.number"}` reads the wallet inside the explore server; the model sees only brand, kind and last four (`describeCard`, `cardEnding`). A profile field goes the same way (`place{secret:"profile.taxId"}`), on any host: it is the person's own, not a site's login. The wallet has its own Keychain item so opening credentials never opens cards (`WALLET_KEYCHAIN`, `src/auth/keep.ts:17`).

## Shape

- `Card { label, kind, holder, number, expMonth, expYear, cvc, postal?, owner?, email?, phone?, addedAt }` — `src/money/wallet.ts:29-50`; `luhn`, `cardBrand`, `admitCard`, `parseCardLine`, `cardFromFields` — `:53-198`
- `Wallet`, `fileWallet` (`~/.config/autobrowse/wallet.sealed`, `src/app/config.ts:223`), `ssmWallet` (`/wallet/cards`), `backedUpWallet`, `pickCard` — `src/money/wallet.ts:200-458`; `cardSecret(name)` — `:415`
- `Profile`, `Address`, `contactsOf`, `ProfileStore` (`/wallet/profiles`) — `src/money/profile.ts:36-239`
- `profileSecret` (`profile.<field>`, `profile@<id>.<field>`), `profileField` — `src/money/profile.ts:130-149`; explore reads them through `profiles` (`profilesForPlace`, `src/app/services.ts:747`)
- `Charge`, `Receipt`, `Invoice`, `reportCharge` (texted, emailed, written down) — `src/money/charges.ts:18-160`; `cardsOnFile` (which card each host holds) — `src/explore/server.ts:341-345`

## Connected to

- **owned-by:** the wallet store
- **joins:** [[approval]] (a placed card is a gated act), [[explore-session]] (`cards`, `cardsOnFile`, `charges`), [[channel]] (charge notes), [[need]] (`kind: money`)
- **looks-like-but-is-not:** [[credential]]; a [[token]]

## If you change this

- **Hits:** `src/explore/server.ts:326-353`, `src/money/profile.ts`, `src/money/charges.ts`, `src/app/services.ts:694-822` (`walletFor`, `profilesFor`, `profilesForPlace`, `cardsFor`, `chargesFor`), `src/app/cli-wallet.ts`, `src/auth/ingest.ts`.
- **Does not hit:** the credential vault; site API tokens.

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse wallet`, `profile` | write |
| explore `place` | reads a field, never prints it |

## See

- Source: `src/money/wallet.ts`, `src/money/profile.ts`, `src/money/charges.ts`
