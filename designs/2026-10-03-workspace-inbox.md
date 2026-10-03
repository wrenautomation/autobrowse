# workspace-inbox: one Workspace inbox, ready to use

2026-10-03. Code: `src/workflows/workspace-inbox/index.ts`. Test: `test/workspace-inbox.test.ts`.

## What it does

Give it an address on a domain Workspace already serves. It makes the user (or keeps it), stores a random password and an authenticator seed as `google@<address>`, so the inbox's browser profile signs itself in. Then it sets the signature and picture, keeps a Gmail consent token as `GMAIL_REFRESH_TOKEN__<ADDRESS>`, and adds the address to the accounts list (`accounts.json`) for its purposes.

Warmup, the wren roster with loops, and newsletter activity are off by default. Each is one plan flag.

```
autobrowse inbox will@getwren.co Will Jin                 # on the worker (Restate)
autobrowse inbox will@getwren.co Will Jin --consent gmail,drive --for sends,signup
autobrowse try workspace-inbox --plan plan.json --ask      # in this process
```

Steps: domain-ready, inboxes!, signatures, authenticator, photo, consent, account, warmup, roster!, loops!, subscribe!, confirm. `!` = irreversible.

## How it is built

It has no step logic of its own beyond three small steps. The rest are the `domain` and `inbox-activity` workflows' steps, run on this plan seen as theirs (`asDomainPlan`, `asActivityPlan`, wrapped by `onPlan`). A fix to a domain step fixes this workflow too.

The three new steps:

- `domain-ready` reads the domain from the admin API and fails with the command that provisions it (`autobrowse domain <d>`). Adding a domain means DNS, verification and DKIM, which is the domain workflow's job.
- `consent` runs `site setup <site> consent --account <address>` through the sites facade, once per site in the plan. Deps answer `held(site, address)` from the setup step's `makes` and the env store, so a rerun skips a kept token.
- `account` adds the plan's purposes to the address's row, keeping any it had.

## Decision log

- 2026-10-03: Compose the existing steps, do not copy them. The domain workflow already makes inboxes idempotently and keeps passwords out of the memo.
- 2026-10-03: An existing user with no stored password still hits the domain step's `password` gate before any reset. `try` approves gates unless `--ask`, so runs on live inboxes use `--ask`.
- 2026-10-03: Handoff, warmup and activity default off. Roster plus loops starts sending, which needs William's say.
- 2026-10-03: The domain must already be in Workspace and verified. This workflow does not add domains.
- 2026-10-03: Proven on william@wren-automation.net with real APIs: every step kept or skipped, nothing changed.
