# Owner keys: one autobrowse, many owners

2026-09-30. Status: built. Live proof passed on prod AWS (below).

## Ask

William: make what's built usable by several businesses, with clear data
separation, audit logs and isolation. wren got a Postgres login per client
and a hash-chained audit log (wren `designs/2026-09-30-client-isolation-and-audit.md`).
autobrowse and credvault assumed one owner: every account, profile, ledger
and SSM path was Wren's.

## Shape

An **owner** is a tenant: its own accounts, credentials, profiles, ledgers,
access keys and SSM path. One process serves one owner. `AUTOBROWSE_OWNER`
or `--owner <name>` picks it; the default is `wren`. Names follow wren client
ids (`^[a-z][a-z0-9_]{0,39}$`), so a wren client's owner is its client id.

| | Owner `wren` (default) | Owner `<o>` |
|---|---|---|
| Files | `~/.config/autobrowse/…` | `<OWNERS_DIR>/<o>/…` (default `~/.config/autobrowse/owners`) |
| Env | the repo's `.env` | operator settings + `<o>/.env`, nothing else |
| SSM | `/autobrowse/config` | `/autobrowse/owners/<o>/config`; roster `/autobrowse/owners/<o>/roster` |
| AWS | the process's own | role `autobrowse-prod-owners`, session tag `owner=<o>` |
| Keychain | `autobrowse`, wallet `autobrowse-wallet` | `autobrowse-owner-<o>` |
| Restate | `Runs`, `sites`, `browser`, `do`, `desk`, `Compiled`, `domain`, … | same names + `_<o>` (`Runs_<o>`, `sites_<o>`, …) |
| Shots | `<machine>/…`, S3 or S3-compatible | `owners/<o>/<machine>/…`, S3 only |
| Run inputs | `inputs/…` | `inputs/owners/<o>/…` |
| Access keys | `access.json` | `<o>/access.json`: a key opens its owner only |
| Decisions done (`needs`) | `needs-done.json` | `<o>/needs-done.json`; `needs` lists only the owner's rows, commands carry `--owner` |
| Wallet, profile backup | yes | refused: cards are the operator's |
| Domain handoff | roster + wren redeploy + loops | its own roster only (`wren: null`) |
| Box idle stop | on | off: the box is the operator's |
| Memory (Backboard) | `autobrowse` | `autobrowse-<o>` unless its env names one |

An owner's files: `credentials.json` (ledgers, versions and spend grants sit
beside it), `accounts.json`, `caps.json`, `access.json`, `needs-done.json`,
`wallet.sealed` (never opened), `profiles/`, `artifacts/`, `recordings/`,
`.env`. The paths are fixed: an owner's env that sets one is refused, so no
owner can point at another's file.

Keychain is `autobrowse-owner-<o>`, not `autobrowse-<o>`: an owner named
`wallet` would otherwise open the operator's cards.

## Accounts are the owner's; tools are the operator's

The operator (Wren) runs the processes and pays for the tools. Every setting
is in exactly one class (`src/app/owner.ts`):

- **Owner** (`OWNER_SETTINGS`): Cloudflare, Google Workspace, roster,
  notify-from, receipts-to, DMARC, GitHub, wren repo, browser CDP URL, own
  browser, codes inbox, `AUTOBROWSE_ACCOUNTS`, phone number and its Messages
  database, Backboard assistant. Only the owner's `.env` sets them.
- **Per process** (`PROCESS_SETTINGS`): Restate, UI and OAuth ports, log
  level. The operator's value is the default; an owner may pick its own, so
  two workers fit on one machine.
- **Paths** (`OWNER_PATHS`): fixed under the owner's directory.
- **Operator**: everything else in the settings: Restate URLs, AWS region,
  browser tier/proxy/pacing, LLM and eyes, shots bucket, UI host/token,
  OTLP/Sentry, spend limits, notify-to, Linq, Twilio. Plus the tool keys
  every owner uses (`EXA_API_KEY`, `PERPLEXITY_API_KEY`, `BRAVE_API_KEY`,
  `JINA_API_KEY`, `LANGFUSE_*`), `AWS_*` and the process flags
  (`AUTOBROWSE_OWNER`, `AUTOBROWSE_OWNER_ROLE_ARN`, `AUTOBROWSE_DEBUG`).
- **Anything else**: an owner's if the operator's `.env` set it, or it
  carries an owner prefix (`AUTOBROWSE_`, `BROWSERBASE_CONTEXT_`, `GMAIL_`),
  or it is account-shaped (`*_TOKEN`, `*_SECRET`, `*_KEY`, `*_PASSWORD`,
  `*_ID`, `*__<ACCOUNT>`, …). System names (`PATH`, `HOME`, `USER`, …) stay,
  and an owner's file may not set them, nor `NODE_*`, `DYLD_*`, `LD_*` or
  `*_PROXY`: `HOME` would move its fixed files, `NODE_OPTIONS` would run code.

`enterOwner` is the one chokepoint. `boot()` is every entry point's first
line: it loads the operator's `.env`, then, for a non-default owner, rewrites
`process.env` once: drops every name the operator's file set and every
owner-class name, then overlays `<o>/.env`. That file may not set an operator
setting, tool key, flag or fixed path; it throws naming the key, never the
value. Settings refuse to load for an owner whose env was not entered, or for
any owner but the one it was entered for (the default owner too). A second
`enterOwner` for another owner throws; only the default owner may enter again
as itself.

`--owner` is read from argv before the parser (settings load first); the
parser's reading must agree, so a value that only looked like the flag
cannot switch owners.

Shared on purpose: the operator's LLM, tools and Backboard key;
`fixes.json` and `screens.json` (knowledge about sites, not accounts); the
maps scraper; gates notify the operator. Not an owner's to use: the Mac's
own Messages (an owner's phone needs its own `PHONE_MESSAGES_DB`, and one that
resolves to the Mac's `chat.db` is refused), the
operator's Linq and Twilio numbers. `OWN_BROWSER` opens the browser of the
macOS user running the process: run an owner's process as its own macOS user
if it uses one.

## AWS

One role, `autobrowse-prod-owners` (`deploy/terraform/owners.tf`, output
`owner_role_arn`), for every owner. credvault 0.10.0 `ownerCredentials`
assumes it with session tag `owner=<o>`; the policy scopes by
`${aws:PrincipalTag/owner}`:

- SSM read/write/delete/history under `/autobrowse/owners/<o>` and `/*`;
  `DescribeParameters` on `*` (it can't be scoped: names show, never values).
- KMS on the `aws/ssm` key.
- S3 `PutObject` on `owners/<o>/*` (ship only), Get/Put on `inputs/owners/<o>/*`.
- Trust: this account's principals, `AssumeRole` + `TagSession`, exactly one
  session tag, `owner`, non-empty and slash-free.

The box role gets a Deny on `/autobrowse/owners/*`, `owners/*` and
`inputs/owners/*` (its managed SSM policy grants `GetParameter` on `*`), and
may assume the owner role. Every AWS client in autobrowse is built through
`awsFor` (`src/app/owner.ts`): the owner role for a non-default owner, and
it fails closed without `AUTOBROWSE_OWNER_ROLE_ARN`. A test fails if any
other file constructs an AWS client. The operator's `.env` and SSM store
hold the role ARN.

## Proof

`deploy/scripts/owner-proof.mts`, run 2026-09-30 against prod: 14 of 14.
As owner `ownerproof`: own env store write, read, delete ok; the operator's
store, another owner's store and `/wallet/cards` denied; own shots write ok,
read denied; bucket root and another owner's shots denied; own inputs
read/write ok; the operator's and another owner's inputs denied. Also
checked: the CLI as an owner writes and reads its own SSM path only; the box
role's Denies; the trust policy's tag conditions. The script prints outcomes
and error names only (AccessDenied messages carry the account id).

## Running an owner

```sh
mkdir -p ~/.config/autobrowse/owners/acme && $EDITOR ~/.config/autobrowse/owners/acme/.env
pnpm autobrowse --owner acme needs           # what it still owes
AUTOBROWSE_OWNER=acme RESTATE_PORT=9181 UI_PORT=9180 pnpm worker   # its own services, beside wren's
```

Library users: `checkOwner`, `DEFAULT_OWNER`, `isDefaultOwner`, `ownerKeys`,
`named`, `awsConfig`, `registryOf`, `runsRegistryFor` from the package root.

## Trust boundary

The operator runs every owner's process and holds the base AWS credentials.
What keeps owners apart: fixed paths, the scrubbed env, the owner role for
every AWS call, suffixed Restate names and per-owner access keys. On the box,
an owner's worker will run in its own container, env from its own SSM path,
no instance-metadata access; not built yet.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | The default owner keeps every legacy name | Moving live secrets buys nothing and risks the box and the KMS budget |
| 2 | Accounts are the owner's, tools the operator's | An owner brings its accounts; the operator pays for search, LLMs, browsers |
| 3 | `enterOwner` rewrites `process.env` once | ~15 files read `process.env` directly; one chokepoint beats threading an env through each |
| 4 | Fixed owner paths, env overrides refused | A settable path is a way into another owner's files |
| 5 | Tag-scoped role over a session policy per call | A missing tag fails closed, one role serves all owners, CloudTrail shows the owner |
| 6 | Restate names suffixed `_<o>` in the one environment | One Restate Cloud env; a second env per owner is cost and setup for no gain yet. `/` is the only forbidden character |
| 7 | Access key scope `owner` renamed `operator` | "owner" now means a tenant; full access is the operator's |
| 8 | No wallet or profile backup for owners | Cards and their holders are the operator's; an owner's spend goes through the operator's gate |
| 9 | Domain handoff is Wren's only | Roster → wren redeploy → loops runs wren's own senders; an owner's roster is written, the wren leg is skipped |
| 10 | No wren change now | wren calls `sites`; a client that is an owner will call `sites_<id>`. Today wren clients use named accounts under Wren |
| 11 | Keychain `autobrowse-owner-<o>` | `autobrowse-<o>` lets an owner named `wallet` open the operator's cards |
| 12 | Owner shots S3 only | An S3-compatible store (R2) has no per-owner IAM fence |
| 13 | Ports and log level per process | Two workers on one machine need two ports; nothing about them is an account |
| 14 | Idle stop only in the default owner's worker | The box is the operator's; an owner's worker stopping it would stop everyone's |
| 15 | The once-per-process fence covers the default owner | A process entered for `acme` that lost `AUTOBROWSE_OWNER` loaded the operator's settings (found by the adversarial tests) |
| 16 | An owner's file may not set process names | `HOME` moved its fixed files into another owner's tree; `NODE_OPTIONS` runs code |

## Where to attack

1. Owner workers on the box: a container per owner, env from its SSM path, IMDS blocked.
2. wren routes a client's site calls to `sites_<client id>`.
3. `SecretUse.owner` if ledgers ever merge across owners.
4. Shape-based dropping misses names like `LINKEDIN_AUTHOR` and secret URLs set in the shell; on the box nothing comes from a file, so shape is the only filter. An allow-list per owner would close it.
5. An owner's env-file sink can save a tool key (`EXA_API_KEY`) that its next boot refuses.
6. `BROWSER_CDP_URL`, `ROSTER_SSM_PARAM` and `BACKBOARD_ASSISTANT` can name the operator's browser, roster or assistant; fenced only by IAM or the shared key.
7. Every owner's process holds the operator's Restate token, so it can call another owner's `*_<o>` services. Fine while the operator runs everything; not once owners run their own.
