# Account roles

2026-10-02. William: "main / alt takes away visibility, but having some marked
main / alt is also useful."

## What changed

An account is a stored credential: a site, a username (who it is) and roles
(what it is for: `main`, `alt`, `wren`). Three names reach the same account:

- `x`: the main one, or the site's only one
- `x@wren`: the account with role `wren`
- `x@wren_automation`: the account with that username

`creds list` leads with the username, then roles, then how it signs in. The
store key shows only when no name a person would type reaches it.

```
x
  me@gmail.com     main  password
  wren_automation  wren  password
```

`creds role x wren wren_automation` gives a role; `--drop` takes one off.

## How

- `roles` is a credvault field (0.11.0, `ROLE_NAME`: a lowercase word, never
  an `@`, so it can't pass for a username). It travels with the login.
- `src/auth/roles.ts`: `resolveAccount` goes exact key, then role (bare = `main`),
  then username (any case), then a bare site's only account.
- `namedStore` wraps the store, so get/put/remove and the browser profile
  (`profileName`) take any of the three names. A new key is `keyFor(name)`.
- A key's label counts as a role it holds (`claims`): `x@wren` answers to
  `wren`, a bare `x` to `main`. So a key and a role never name two accounts.

## Decision log

- **No rekey, no migration.** Keys stay as they are. Env and SSM names can't
  carry `_` or case (`siteFromEnvName`), so a key can't be the username.
  Profiles, SSM params and wren's names (`reddit@alt`, `x@wren`,
  `linkedin@research`) all key on them. Zero data moved, zero loss risk.
- **Key first.** `push`/`pull` walk `list()` then `get(key)`. Role-first
  would let a key read a different entry. Exact key always wins.
- **One account per role per site.** A put whose roles another account holds
  is refused, with the `creds role` command that moves it.
- **A put keeps roles.** A new password isn't a new purpose. Only a write that
  names roles changes them.
- **Moving a role named by a key** (`reddit@alt` → another account): the old
  entry moves to `site@<username>` by copy, read back, then remove. History
  keeps the old entry. The profile dir moves too, unless a browser has it open.
- **Dropping a key's own role is refused.** Give the role to another account
  instead; that renames the key.
- **Roles are not purposes.** Purposes (`default`, `pays`, `sends`) say which
  address a site call runs as (`auth/identities`). Roles say which account on
  one site. Kept apart.
- **Access scopes stay literal.** `allowsSite` matches the name as given.
  `x@wren_automation` doesn't match a `x@wren` scope. Fails closed.
- **Look-alikes left for William.** `notion` / `notion@william-net` and
  `todoist` / `todoist@william-net` share a username (password vs Google
  sign-in). `google-wren` duplicates `google@wren` under another site name.
  google@ entries for the 24 deleted inboxes stay until he says so. Nothing
  merged or deleted.
