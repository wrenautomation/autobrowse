# The vault leaves autobrowse (credvault)

2026-09-22. Status: step 1 done (credvault on npm, autobrowse on it); expiry kept since 0.2.0;
every credential in SSM since 0.3.0; SSM is the truth since 0.4.0. Named credkeep until 0.3.0 (deprecated on npm).

## Why

autobrowse was two things: a browser that signs in, and the place its
secrets live. They change for different reasons. They also have different
users: wren's worker needs the secrets and never the browser. So the vault
is its own package, and autobrowse is one client of it.

## The line

**credvault** (public, `wrenautomation/credvault`, npm `credvault`). Owns what
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
nothing already stored moves. The seal marker is now `credvault-sealed-v1`.
Files sealed under `credkeep-sealed-v1` or `autobrowse-sealed-v1` still
open, and are resealed on the next write.

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

## Durability

Until 0.3.0, 12 of 16 logins and every passkey and recovery code lived only
in the sealed file on one Mac, under a Keychain key on that Mac. Time
Machine was not mounting. A lost Mac lost them.

Now SSM (`/autobrowse/config/AUTOBROWSE_CRED_*`, SecureString, KMS) is
the truth, and the file on each machine is its offline copy
(`syncedCredentials`, credvault 0.4.0):
- every field travels: strings as they are, passkeys and recovery codes as
  JSON
- a read asks SSM for that site (one call for up to ten fields, reused
  60s, 3s timeout) and refreshes the file when they differ; offline, the
  file answers
- a write lands in the file, then in SSM; a failed copy prints the
  `creds push <site>` that repairs it
- a push clears fields a credential no longer has (used codes)
- canaries never leave the machine
- no pull chore: a new machine's first read of a site fills its file.
  `creds pull` fills it all at once, e.g. before going offline
- the box reads SSM live too. Env baked in at deploy is only the fallback,
  so a changed password is never stale there
- `CREDENTIALS_SHARED=off` turns it off

No Redis or cache server: a handful of reads a day, and SSM is already
the shared store.

Checked 2026-09-22: `creds push --all`, then a rebuild from SSM alone
matched the file for all 16 sites.

## History: a wrong write is undone (credvault 0.5.0)

2026-09-22 a password meant for Wren's LinkedIn landed on William's
personal `linkedin` entry. Moving it back meant a push that deleted the
SSM field, and deleting an SSM parameter deletes its versions. Nothing
kept the state before.

Now every state of a credential is kept:
- one SecureString per site at `/autobrowse/config/history/<SITE>`, a new
  version per change (SSM keeps 100). One level down, so env listings and
  the box's deploy never read it
- a push keeps what SSM held, then what it writes. A push that cannot keep
  the old state writes nothing
- nothing deletes a history parameter
- `creds history <site>`: when, whose (masked), which fields changed;
  never values
- `creds restore <site> <n>`: shows what would change; `--yes` writes it,
  itself a new version, so a restore is undone the same way

Consent guard (autobrowse): a named `--account` with no credential of its
own is refused (409). It used to run in the site's default profile, as
whoever that is.

## Expiry

`put(name, value, { expiresAt })` writes `expires <ISO>` into the SSM
parameter's description. `list()` reads descriptions without decrypting
anything. `expiring(list, ms)` returns what lapses within `ms`.

## Where to attack (ranked)

1. **Renewal is not scheduled.** Expiry is now kept, in credvault 0.2
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
2. **Clean API routes still run on the box.** Today only YouTube has a live
   API token. LinkedIn, Meta, X and TikTok wait on credentials or go through
   the browser, so each YouTube metrics read wakes the box for one GET. Do
   the move once a second API is live, not by copying site definitions into
   wren:
   - lift the routes' API legs (schemas, `api`, token minting) into a package
     with no browser code
   - wren wraps its `SiteClient` so a route with a token in the vault
     (`ssmEnvStore(ssm, "/autobrowse/config")`) is called directly, and
     everything else still goes to autobrowse
   - the Lambda role needs read access to `/autobrowse/config/*`
3. **wren's own SSM code stays as it is** (`apps/worker/src/ssm-env.ts`,
   provision's `ssmSecretStore`). Checked 2026-09-22: it is a JSON env blob
   for Lambda plus per-inbox password paths containing `@`. Neither is one
   name per parameter, and neither shares autobrowse's path. Moving it
   would change prod for nothing. Revisit only if wren needs expiry.
4. **One vault for everyone.** Client isolation is the `KEYCHAIN` /
   `CRED_ENV` / `ENV_STORE_PREFIX` triple in `keep.ts`. Today it is a
   constant. It needs to be per client before a second client exists.
5. **The AWS account is the last single point.** SSM holds every
   credential, including the AWS login itself. Losing the AWS root login
   (or the account) loses the lot. Its password and 2FA need a copy
   outside AWS: William's password manager or paper.
6. **History starts now.** Versions exist from the first write after
   0.5.0; `creds push --all` seeds every site once. Writes made while SSM
   was down (file only) are kept at the next push, not before.
7. **Legacy seal markers** (`credkeep-sealed-v1`, `autobrowse-sealed-v1`)
   stay readable forever unless dropped. Once every file has been
   rewritten, remove them.

Checked and dropped: `via` is a plain string in credvault, and autobrowse
casts it. That is fine: `providerOf` throws "no identity provider named X"
on a typo.
