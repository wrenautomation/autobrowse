# designs

Living design docs with decision logs, one per flow, written as each is
decided. Each ends with a ranked "where to attack"; ✅ marks what landed.

| Doc | What it decides |
|-----|-----------------|
| [architecture](2026-09-19-architecture.md) | engine, recorder, compiler, runner: the shape of the repo |
| [deploy](2026-09-19-deploy.md) | Restate Cloud tunnel, the EC2 box, CI deploys every push |
| [domain-flow](2026-09-19-domain-flow.md) | the first workflow: buy, DNS, Workspace, inboxes, warmup |
| [boundary-review](2026-09-20-boundary-review.md) | what autobrowse does vs APIs vs wren |
| [oauth-sign-in](2026-09-20-oauth-sign-in.md) | "Sign in with Google/GitHub/Microsoft" as a first-class path |
| [async-and-api](2026-09-21-async-and-api.md) | concurrency rules, jobs, paging, payload shape |
| [claude-code-driver](2026-09-21-claude-code-driver.md) | Claude Code on the subscription as an LLM driver |
| [desktop-leg](2026-09-21-desktop-leg.md) | OS actions: apps, menus, dialogs, root commands |
| [healing](2026-09-21-healing.md) | a failed step re-explored and recompiled |
| [one-verb](2026-09-21-one-verb.md) | `do`: route to an API, a workflow, or build one |
| [payment-gate](2026-09-21-payment-gate.md) | every spend stops at a gate; policy, ledger, canaries |
| [sdk-layers](2026-09-21-sdk-layers.md) | using autobrowse as a library, layer by layer |
| [site-apis](2026-09-21-site-apis.md) | a site as a service under its official REST shape |
| [accounts](2026-09-22-accounts.md) | accounts the agent makes; which account is for what |
| [performance](2026-09-22-performance.md) | bounded stores, cached reads, what crosses a wire |
| [secrets-and-money-sandbox](2026-09-22-secrets-and-money-sandbox.md) | credentials, spend policy, virtual cards |
