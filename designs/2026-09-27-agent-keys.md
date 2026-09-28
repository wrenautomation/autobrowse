# Agent keys: what each agent may touch

2026-09-27. Status: built (HTTP API). Restate-side checks and spend caps not built.

## Ask

William: agents that use autobrowse should see only their tools. A designer
agent gets Higgsfield and what else fits, nothing more. Whose job is that,
autobrowse's or the client's?

## Answer: autobrowse enforces, the client chooses

- autobrowse holds the things worth fencing: passwords, tokens, cards,
  signed-in browser profiles. Only the holder can refuse. A client-side
  filter is a suggestion: an agent with the one bearer can call anything.
- The client (wren, a person, an agent runner) decides which agent gets which
  key. autobrowse never guesses roles.
- The in-code API "has this already" only because a caller imports a few
  clients. The credential store behind them is still shared. Same gap.

Same split as AWS IAM: the service enforces, the caller picks the role.

## Shape (built)

One key per agent: `abk_<name>_<32 random bytes>`. Stored as a sha256 in
`~/.config/autobrowse/agent-keys.json` (0600, `AGENT_KEYS_FILE`). Shown once.

```json
{
  "name": "designer",
  "sites": ["higgsfield", "canva@*", "github@wren"],
  "workflows": ["higgsfield-*"],
  "tools": ["ffmpeg"],
  "can": ["do", "agent"]
}
```

- `sites`: a site plus its accounts. `github` = the default account,
  `github@wren` = that one, `github@*` = all. Folds in the old `accounts`.
- `workflows`: names; a trailing `*` is a prefix.
- `tools`: command-line tool abilities.
- `can`: `do`, `run` (start and steer runs), `sites` (site APIs),
  `agent` (explore sessions).

Missing = nothing. `UI_TOKEN` (or local use with no token) is the owner.

## Where it bites (built)

1. `accessAuth`: bearer → owner, an agent `Scope`, or 401.
2. `access/fence.ts`: one table of what an agent may call. Everything else is
   the owner's: gates (approve/reject), setup, accounts, needs, wallet,
   policy, ledger, recordings, compile, heal/repair, explore `exec`, settings
   writes.
3. Lists (abilities, workflows, sites, runs, jobs, events, agent sessions)
   show only the scope.
4. `do` for an agent is its own `doerFor({scope})`: the catalog is cut, and
   each door (site call, workflow, flow, tool) checks again. The agent and
   compile legs exist only with `can: agent`.
5. Jobs record who started them (`by`).

## Not built

- Spend caps per key. The SMS yes still guards every payment.
- The key name on Restate invocations and ledgers.
- SSM storage. Local file for now; the box has one owner.

## CLI

`autobrowse keys add designer --sites higgsfield,canva@* --can do,agent`
prints the key once. `keys list` (never the key), `keys revoke designer`.

## Where to attack

1. A site that signs in through a provider (github via google) runs in the
   provider's profile. An agent in that session could navigate to Gmail.
   Rule to build: an agent session only on the site's own origins.
2. Explore `exec` (eval, open anywhere) is the owner's. Done.
3. Workflows that call other workflows: check the inner ones too.
4. Browser profiles are shared per identity. Two agents on one account share
   cookies; fine if both keys list that account.
5. A workflow is granted whole: every site it touches comes with it.
6. The fence is the API. An agent with a shell on the worker is the owner.
