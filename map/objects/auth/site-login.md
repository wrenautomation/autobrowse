---
type: object
cluster: auth
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/auth/login.ts
---

# Site login

How one site is signed into and where its password may be typed: `SiteLogin` in `src/auth/login.ts`; the list is `SITE_LOGINS` in `src/auth/sites.ts:854`.

## Why this shape

The runner meets a wall and calls one hook (`RunnerOptions.login`); the spec says which credential, which origins, whether a provider button will do, and how second steps, passkeys, rotation and recovery codes walk on that site. A simple form is `formLogin`; a branching sign-in is a walk (Google, Cloudflare).

## Shape

- `SiteLogin { site, home, credential?, ask?, via?, loggedIn, signIn, signInHere?, totpSetup?, passwordChange?, passkeySetup?, recoveryCodes?, origins? }` — `src/auth/login.ts:55-94`
- Builders: `formLogin` `:194`, `oauthLogin` `:275` (`before` clicks open the sign-in; a site made through a provider signs in as its own account there, never the provider's default credential), `viaLogin` `:322`; `LoginFailed` (this method failed, try the next) `:175`
- `loginProvider(sites, opts)` = the runner's hook: resolves the site, picks methods, signs in, returns `signed-in | no-credential | unknown-site` — `:545-602`
- Wired: `loginFor` — `src/app/services.ts:666`

## Connected to

- **owns:** its walk or form
- **owned-by:** `SITE_LOGINS`
- **joins:** [[credential]], [[identity-provider]] (`via`), [[sign-in-context]], [[screen]] (walks), [[guard]] (`passwordDomains`, `src/auth/login.ts:399`), [[need]]
- **looks-like-but-is-not:** [[site-api]] (the official API), `SITES` in `src/browser/flow.ts:63`

## If you change this

- **Hits:** `src/auth/sites.ts`, `src/app/services.ts:666`, `src/auth/accounts.ts` (`check`), `src/app/needs.ts:93`, `src/auth/enroll.ts`, `src/auth/rotate.ts`, `src/auth/recovery.ts`, `src/auth/passkey.ts`, `src/auth/exists.ts`.
- **Does not hit:** site API routes; compiled workflows (they meet the wall through the same runner hook, unchanged).

## Surfaces

| Surface | Role |
|---|---|
| runner wall hook | calls `signIn` |
| `autobrowse login`, `accounts check`, `enroll-*`, `creds rotate` | call the specs |

## See

- Source: `src/auth/login.ts`, `src/auth/sites.ts`
