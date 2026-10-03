---
type: object
cluster: money
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/gates/payment.ts
---

# Approval

One question to a person before a browser act that spends: `Approval`, `Approver`, `PaymentGate` and `PendingApprovals` in `src/gates/payment.ts`. Product word: the payment gate.

## Why this shape

One question per act, asked once and remembered until answered and consumed. A caller that cannot wait (an HTTP command) is told `asked` and comes back with the same act; a caller that can (the agent) waits (`src/gates/payment.ts:147-175`). Only an explicit yes lets the act happen.

## Shape

- `Approval { what, url, site, amount? }`; `Approver = (ask) => true | false | null` — `src/gates/payment.ts:105-119`
- `GateReason = no-approver | denied | no-answer | asked`; `PaymentGate` with the wording — `:122-145`; `PendingApprovals.decide(key, ask, wait)` — `:147`
- What counts as spending: `chargesNow(hints)`, `paymentGate(act, hints)`, `paymentAmount`, `totalIn`, `amountNear` — `:25-103`
- Asked over a channel: `askOverChannel` — `src/gates/ask.ts:27`; policed by [[spend-policy]]; wired by `approverFor` — `src/app/services.ts:1023`

## Connected to

- **owned-by:** the explore session (`approve`), the runner, [[site-facade]] (`approve` for `spends` routes)
- **joins:** [[spend-policy]], [[channel]] (the question and the yes), [[card]] (a placed card is one such act), [[hints]]
- **looks-like-but-is-not:** an engine [[gate]] (`purchase` on a run: state on Restate, not a live question)

## If you change this

- **Hits:** `src/gates/spend.ts:197` (`policedApprover`), `src/gates/ask.ts`, `src/explore/server.ts`, `src/browser/flow.ts` (act path), `src/sites/facade.ts`, `src/app/services.ts:1023`, `src/money/charges.ts`.
- **Does not hit:** `src/engine/effects.ts`; the vault.

## Surfaces

| Surface | Role |
|---|---|
| a person, by SMS or email | answers |
| explore, runner, facade | ask |

## See

- Source: `src/gates/payment.ts`, `src/gates/ask.ts`
