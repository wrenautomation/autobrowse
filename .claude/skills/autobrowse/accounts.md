# Accounts, credentials, keys

Names only, ever: every command here prints names, states and dates, never a value.

## Which account does what

```sh
autobrowse accounts                        # each account's purposes and readiness (credential, inbox, tokens)
autobrowse accounts list --for <purpose>   # one purpose or group (pays, default, signup, sends, …)
autobrowse accounts add <address…> --for <purpose>
autobrowse accounts push                   # the policy to the box
```

Consents, signups and a site's `via` provider read this policy. A site made
through a provider (`creds via <site> google`) signs in as that provider account.
A site with no password, only a code emailed each time (Cap), is
`creds via <site> email --account <address> --url <login page>`.

## Credentials (sealed store)

```sh
autobrowse creds list [platform]           # stored sites; reads SSM in prod, so not in a loop
autobrowse creds copy <site> [account]     # one field on the clipboard for a minute; never printed
autobrowse creds link <site[:account]>... [--keys A,B] [--open] [--ttl 24h]  # one-time link (one reveal): logins and env keys; --open = no sign-in, only when William asks for one to send out; Wren's accounts only unless he names one; one per ask
autobrowse creds paste <site>@<label>      # William's `email password [key]` from the clipboard
autobrowse creds push <site> | --all       # to SSM, so the box signs in too; `pull` the other way
autobrowse creds history <site>            # versions kept; `restore <site> <version>`
autobrowse enroll-totp <site>              # reads the seed, stores it, confirms
```

Never `creds rotate` or `creds password`: those change a password, and that is
William's alone.

## Keys and env (the env store: `.env` locally, SSM in prod)

```sh
autobrowse env ls                          # names, when each changed, when it lapses
autobrowse env set <NAME> --clipboard      # William copies the value; it never passes through you
autobrowse env expires <NAME> <when>
```

`env get` puts a value on William's clipboard. `--print` exists; don't use it.
Never open `.env` for values; never source it in a shell.

## What only William can give

```sh
autobrowse needs                           # open rows, each with its check and command
autobrowse needs do <id>                   # runs the row's ingestion (clipboard creds, a consent, a setup step)
autobrowse needs done <id> --note "…"      # a decision or a by-hand step is done
```

Keep `NEEDS-WILLIAM.md` (repo root) in step when a row is added or cleared.

## Other agents' access and cards

- `autobrowse access grant <name>` — a key for another agent. It prints once, so William runs it. `list`, `revoke`.
- `autobrowse wallet list` — brand, kind, last 4 of each card. Numbers never print.
