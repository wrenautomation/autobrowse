# Payment gate

William, 2026-09-21: "Billing needs to have some sort of approval gate for
filling in information + payment." Prompted by autobrowse reaching the
Anthropic buy-credits form on its own.

## Decision

Money is a person's decision; the machine detects the surface and stops.

- `src/gates/payment.ts`: `paymentGate(act, hints)` names why an act needs
  a person: a `fill`/`select` into a billing field (card, CVC, expiry,
  IBAN, routing, tax id, VAT, billing address) or a `click` on a button
  that spends (buy, pay, purchase, subscribe, checkout, add funds/credits,
  top up, start trial, add payment method). Detection is by the element,
  so an unmapped checkout still stops. "Upgrade" is not gated: it opens a
  page; the form after it is gated.
- Explore session (`approve?: Approver`): the element is located first (a
  miss is a miss, nobody is asked), then the person is asked; a no, no
  answer in 30 minutes, or no channel → `PaymentGate` → HTTP 403
  `{gate:"payment", reason}` and nothing happens. Over the socket a plain
  request answers 202 `asked` at once and the same command re-asks;
  `?wait=1` (what `cmd.sh` sends) holds the request until the answer. Every CLI session and the
  daemon's agent sessions get `approverFor(settings)`.
- `src/gates/ask.ts`: `askOverChannel` sends one line ("autobrowse on
  anthropic wants to press "Buy $20 of credits", which spends at <url>.
  Reply yes or no.") and takes the first reply after it that parses as
  yes/no (`parseCommand`). Phone first, then Linq, then email (replies land
  in the sending inbox).
- Agent: a `PaymentGate` ends the goal (not achieved, the gate's message
  as summary) instead of the model trying another way.
- Compiler: a step with a billing op is `irreversible`, so the run gates
  on the person before it, like any irreversible step. Card values are
  already secrets by field name.
- Skill: told not to work around the gate.

- 2026-09-22: spend policy in front of the person (`src/gates/spend.ts`;
  `designs/2026-09-22-secrets-and-money-sandbox.md` #3): amount in the ask,
  auto-yes under a cap on allowed sites, hard ceiling, spend ledger.

## Where to attack

- Phone replies: notes to the person go to their own number; whether a
  reply from the phone lands in `chat.db` as `is_from_me = 0` is
  unverified. If not, the phone approver never hears a yes and every
  payment is a no until Linq/email is set. Verify with one real ask.
- The gate is name-based. A button labelled "Continue" on a checkout's
  last page spends without matching; the billing fields before it are
  the catch. A site that takes a saved card with one unlabeled click gets
  through.
- `type` (into the focused element) and `eval` bypass the gate by design
  of those commands; the skill and the agent prompt say not to.
- ✅ (2026-09-21) Desktop clicks go through the same gate: an `os` click whose name reads as spending (`PAYMENT_ACTION`) is asked as `press "Buy", which spends in <app>` once the control is in the tree; `type`, `key` and `shell` are not gated (as with the page's `type`/`eval`).
