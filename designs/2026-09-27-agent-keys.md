# Agent keys: what each agent may touch

2026-09-27. Status: design, not built.

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

## Shape

One key per agent, stored like any secret (SSM, hashed at rest):

```json
{
  "name": "designer",
  "sites": ["higgsfield", "canva"],
  "accounts": ["william@wrenautomation.com"],
  "workflows": ["higgsfield/*"],
  "spend": { "cards": [], "perDayUsd": 0 },
  "tools": ["explore", "run"]
}
```

- `sites`: site APIs, explore, login and flows on these sites only.
- `accounts`: which identities it may act as. Never an account it isn't given.
- `workflows`: compiled workflows by glob.
- `spend`: cards it may use and a cap. Default none. The SMS yes still applies.
- `tools`: which verbs (`do`, `run`, `explore`, `site call`, `creds`). `creds`
  is never given to an agent key: an agent never reads a secret, it only
  uses one inside a flow.

Unknown or missing field = nothing. The current single bearer becomes the
`owner` key (everything).

## Where it bites

1. HTTP: `bearerAuth` resolves the key → a `Scope` on the request context.
2. `do` catalog: `abilitiesOf` filtered by scope, so the picker never sees
   the rest. This is the "what they see" part.
3. Every door checks again: site facade, run, explore start, login, wallet
   gate. Seeing less is not the fence; the check at the door is.
4. Restate: the key name rides on the invocation; durable steps check it too.
5. Ledgers: every run, spend and secret use records the key name.

## CLI

`autobrowse keys add designer --sites higgsfield --accounts william@wren…`,
`keys list`, `keys revoke`. The value is shown once, like a token.

## Where to attack

1. A flow on an allowed site that clicks "Continue with Google" reaches the
   Google profile. Rule: a provider login is allowed only if the account is
   in `accounts`.
2. Explore `eval` runs arbitrary page JS: no `eval` for agent keys.
3. Workflows that call other workflows: check the inner ones too.
4. Browser profiles are shared per identity. Two agents on one account share
   cookies; fine if both keys list that account.
