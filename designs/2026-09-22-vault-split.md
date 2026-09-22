# The vault leaves autobrowse (credkeep)

2026-09-22. Status: step 1 done (credkeep on npm, autobrowse on it); expiry kept since 0.2.0.

## Why

autobrowse was two things: a browser that signs in, and the place its
secrets live. They change for different reasons. They also have different
users: wren's worker needs the secrets and never the browser. So the vault
is its own package, and autobrowse is one client of it.

## The line

**credkeep** (public, `wrenautomation/credkeep`, npm `credkeep`). Owns what
is true of a secret with no page in sight:
- the sealed credential file (AES-256-GCM, key in the Keychain), plus env,
  memory and layered stores; push/pull through SSM
- the SSM env store for named keys, with expiry
- the hash-chained audit ledger, canaries, TOTP, and the password generator

**autobrowse** keeps everything that needs a page:
- the guard: a secret is typed only on its own site (`boundPage`,
  `guardedPage`, `SecretLeak`)
- logins, code sources, enroll, passkeys, recovery codes, signup, rotate

`src/auth/keep.ts` holds autobrowse's names in the vault: Keychain item,
env prefix, SSM path, secret prefix. The values are the old ones, so
nothing already stored moves. The seal marker is now `credkeep-sealed-v1`.
Files sealed under `autobrowse-sealed-v1` still open, and are resealed on
the next write.

## Free APIs: who owns a route

autobrowse owns a route only if some part of it needs a browser. That
covers minting the token (consent, a settings page) and endpoints with no
API. A clean REST call made with a token we already hold belongs to the
caller (wren). autobrowse hands over the token through the vault and is
done.

## What clients get

A hosted service. The client delegates access: OAuth consent, or an invite
to their account. Passwords are the last resort. Each client gets their own
vault prefix, browser profiles and ledger. Onboarding is one page: every
account we need, each marked ready or not, and one button per missing one.
No scripts to run.

## Expiry

`put(name, value, { expiresAt })` writes `expires <ISO>` into the SSM
parameter's description. `list()` reads descriptions without decrypting
anything. `expiring(list, ms)` returns what lapses within `ms`.

## Where to attack (ranked)

1. **Renewal is not scheduled.** Expiry is now kept, in credkeep 0.2
   (`envFileStore` stores it as a comment; SSM keeps it in the description):
   - the npm token flow records its 90 days
   - `env expires <name> <date>` backfills a token minted by hand
   - `env ls` shows the expiry
   - the `token-<site>` row in `needs` reopens 14 days before a token lapses,
     and `needs do token-npm` mints a new one

   Still open: nothing runs `needs do` on its own. It needs a scheduled job
   (wren's Restate, once a day) that renews every reopened token row that
   has a setup step. OAuth access tokens stored without a refresh token also
   do not record `expires_in` yet.
2. **wren still has its own SSM secret code** (`apps/worker/src/ssm-env.ts`,
   `packages/provision` `ssmSecretStore`). That makes two readers of one
   path, each with its own rules. Move both onto credkeep.
3. **The sites facade still makes clean API calls** (YouTube reads, npm
   REST, LinkedIn reads). Per the rule above, those move to wren. The
   browser legs and setups stay.
4. **One vault for everyone.** Client isolation is the `KEYCHAIN` /
   `CRED_ENV` / `ENV_STORE_PREFIX` triple in `keep.ts`. Today it is a
   constant. It needs to be per client before a second client exists.
5. **`via` is a plain string in credkeep.** autobrowse casts it to
   `Provider` at the one place it reads it (`login.ts`). A typo in a stored
   credential shows up as "no provider", not as a parse error.
6. **The legacy seal marker** stays readable forever unless we drop it.
   Once every file has been rewritten, remove it in credkeep 0.2.
