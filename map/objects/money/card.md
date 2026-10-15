---
type: object
cluster: money
universe: live
status: verified
verified: 2026-10-15 @ d3f6dd8+
entity: src/money/wallet.ts
---

# Card

A payment card in the wallet, placed into a checkout by field name after one yes per card and host: `Card` and `Wallet` in `src/money/wallet.ts`; the billing identity is a `Profile` (`src/money/profile.ts`); a charge that went through is a `Charge` (`src/money/charges.ts`).

## Why this shape

Cards never pass through a model or a log: `place{secret:"card.number"}` reads the wallet inside the explore server; the model sees only brand, kind and last four (`describeCard`, `cardEnding`). A profile field goes the same way (`place{secret:"profile.taxId"}`), on any host: it is the person's own, not a site's login. Billing contacts are enforced, not asked for (William, 2026-10-04): when a card lands and before a spend click, every visible billing email, phone and tax id field in every frame gets the card owner's value (`fillBilling`, `BILLING_FIELDS`; `billingKind`, `holdsBilling`), so a site's prefilled login email never becomes the receipt address. The wallet has its own Keychain item so opening credentials never opens cards (`WALLET_KEYCHAIN`, `src/auth/keep.ts:17`). The bank's 3-D Secure text is typed the same way (`place{secret:"card.code"}`, `card@<label>.code`): it belongs to one payment, so the session hands it out only after a `place card.*` this session, inside the payment yes for the flow the card landed on (or a live `spend --grant` for the site), within `CODE_WINDOW_MS` (10 min), and only a text that arrived after the card. Any host and frame may have it: the challenge is an iframe on the bank's domain, so the host check does not apply and the frame search reaches it (`MAX_DEPTH` 5, `src/browser/frames.ts`). It is read from the paired phone's Messages only (`cardCodeFor`), never a Linq or Twilio line.

## Shape

- `Card { label, kind, holder, number, expMonth, expYear, cvc, postal?, owner?, email?, phone?, addedAt }` — `src/money/wallet.ts:29-50`; `luhn`, `cardBrand`, `admitCard`, `parseCardLine`, `cardFromFields` — `:53-198`
- `Wallet`, `fileWallet` (`~/.config/autobrowse/wallet.sealed`, `src/app/config.ts:227`), `ssmWallet` (`/wallet/cards`), `backedUpWallet`, `pickCard` — `src/money/wallet.ts:200-458`; `cardSecret(name)` — `:415`
- `Profile`, `Address`, `contactsOf`, `ProfileStore` (`/wallet/profiles`) — `src/money/profile.ts:36-239`
- `profileSecret` (`profile.<field>`, `profile@<id>.<field>`), `profileField` — `src/money/profile.ts:130-149`; explore reads them through `profiles` (`profilesForPlace`, `src/app/services.ts:852`)
- `bankCodeSecret` (`card.code`, `card@<label>.code`), `codeWindowOpen`, `bankCodeReader` (newest numeric text after the card; a handed-out text is spent) — `src/money/bank-code.ts`; `placeBankCode` and the `cardLanded` state in `src/explore/server.ts`; `cardCodeFor`, `grantedAheadFor` in `src/app/services.ts`
- `Charge`, `Receipt`, `Invoice`, `reportCharge` (texted, emailed, written down) — `src/money/charges.ts:18-160`; `cardsOnFile` (which card each host holds) — `src/explore/server.ts:381-385`

## Connected to

- **owned-by:** the wallet store
- **joins:** [[approval]] (a placed card is a gated act), [[explore-session]] (`cards`, `cardsOnFile`, `charges`), [[channel]] (charge notes), [[need]] (`kind: money`)
- **looks-like-but-is-not:** [[credential]]; a [[token]]

## If you change this

- **Hits:** `src/explore/server.ts:366-393`, `src/money/bank-code.ts`, `src/browser/frames.ts`, `src/money/profile.ts`, `src/money/charges.ts`, `src/app/services.ts:779-907` (`walletFor`, `profilesFor`, `profilesForPlace`, `cardsFor`, `chargesFor`), `src/app/cli-wallet.ts`, `src/auth/ingest.ts`.
- **Does not hit:** the credential vault; site API tokens.

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse wallet`, `profile` | write |
| explore `place` | reads a field, never prints it |

## See

- Source: `src/money/wallet.ts`, `src/money/profile.ts`, `src/money/charges.ts`
