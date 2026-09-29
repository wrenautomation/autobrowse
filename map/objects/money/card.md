---
type: object
cluster: money
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/money/wallet.ts
---

# Card

A payment card in the wallet, placed into a checkout by field name after one yes per card and host: `Card` and `Wallet` in `src/money/wallet.ts`; the billing identity is a `Profile` (`src/money/profile.ts`); a charge that went through is a `Charge` (`src/money/charges.ts`).

## Why this shape

Cards never pass through a model or a log: `place{secret:"card.number"}` reads the wallet inside the explore server; the model sees only brand, kind and last four (`describeCard`, `cardEnding`). The wallet has its own Keychain item so opening credentials never opens cards (`WALLET_KEYCHAIN`, `src/auth/keep.ts:9`).

## Shape

- `Card { label, kind, holder, number, expMonth, expYear, cvc, postal?, owner?, email?, phone?, addedAt }` — `src/money/wallet.ts:29-50`; `luhn`, `cardBrand`, `admitCard`, `parseCardLine`, `cardFromFields` — `:53-198`
- `Wallet`, `fileWallet` (`~/.config/autobrowse/wallet.sealed`, `src/app/config.ts:182`), `ssmWallet` (`/wallet/cards`), `backedUpWallet`, `pickCard` — `:200-450`; `cardSecret(name)` — `:415`
- `Profile`, `Address`, `contactsOf`, `ProfileStore` (`/wallet/profiles`) — `src/money/profile.ts:36-210`
- `Charge`, `Receipt`, `Invoice`, `reportCharge` (texted, emailed, written down) — `src/money/charges.ts:18-160`; `cardsOnFile` (which card each host holds) — `src/explore/server.ts:328-332`

## Connected to

- **owned-by:** the wallet store
- **joins:** [[approval]] (a placed card is a gated act), [[explore-session]] (`cards`, `cardsOnFile`, `charges`), [[channel]] (charge notes), [[need]] (`kind: money`)
- **looks-like-but-is-not:** [[credential]]; a [[token]]

## If you change this

- **Hits:** `src/explore/server.ts:319-340`, `src/money/profile.ts`, `src/money/charges.ts`, `src/app/services.ts:670-791` (`walletFor`, `profilesFor`, `cardsFor`, `chargesFor`), `src/app/cli-wallet.ts`, `src/auth/ingest.ts`.
- **Does not hit:** the credential vault; site API tokens.

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse wallet`, `profile` | write |
| explore `place` | reads a field, never prints it |

## See

- Source: `src/money/wallet.ts`, `src/money/profile.ts`, `src/money/charges.ts`
