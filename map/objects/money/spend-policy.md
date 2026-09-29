---
type: object
cluster: money
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/gates/spend.ts
---

# Spend policy

When the gate may say yes on its own, what it has already spent today, and the yeses given ahead: `SpendPolicy`, `SpendLedger`, `Grants`, `policedApprover` in `src/gates/spend.ts`.

## Why this shape

Spend is the person's decision. The policy defaults to never (`NO_AUTO_SPEND`); an allow-list, a per-purchase ceiling, a daily cap and a hard cap bound what the code decides, and every decision is a ledger row with who decided.

## Shape

- `SpendPolicy { allow, autoYesUnder, dailyCap, hardCap }` — `src/gates/spend.ts:41-58`; `Amount`, `amountIn` — `:12-39`
- `Decided = auto | person | granted | cap | denied | unanswered`; `SpendRecord`; `SpendLedger` — `:60-90`; `spentToday` — `:104`
- `Grant`, `Grants` (`spend grant`) — `:117-180`; `policedApprover(ask, o)` — `:197`
- Wired: `spendPolicyFor`, `spendLedgerFor`, `spendGrantsFor` — `src/app/services.ts:926-941`

## Connected to

- **owned-by:** [[approval]] (wraps the approver)
- **joins:** [[site-api]] (`spends`), [[settings]] (the policy env), the ledger surface (`/api/ledger`)
- **looks-like-but-is-not:** the LLM budget (`budgetOf`, `src/app/services.ts:354`)

## If you change this

- **Hits:** `src/gates/payment.ts` callers, `src/app/services.ts:911-941`, `src/app/cli-wallet.ts` (`spend` verbs), `src/auth/ledger.ts` (ledger window includes spend rows).
- **Does not hit:** engine gates; the wallet's cards.

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse spend grant/policy`, env | write |
| approver | read |

## See

- Source: `src/gates/spend.ts`
