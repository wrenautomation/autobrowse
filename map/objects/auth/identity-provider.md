---
type: object
cluster: auth
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/auth/providers.ts
---

# Identity provider

A sign-in reused by every site that shows its button: `IdentityProvider` in `src/auth/providers.ts` (google, github, microsoft). Google's is the walk in `src/auth/google.ts`.

## Why this shape

"Sign in with Google" on any site lands on the same pages, so one sign-in serves all of them. The registry is filled at import time by the file that owns each sign-in, so nothing cycles (`src/auth/providers.ts:24-30`).

## Shape

- `PROVIDERS`, `IdentityProvider { site, host, buttons, signIn }`, `registerProvider`, `providerOf` — `src/auth/providers.ts:11-37`
- Google: `googleWalk(ctx)` (17 screens, second step by passkey → TOTP → SMS → Tap Yes) and `signInToGoogle` — `src/auth/google.ts`
- GitHub, Microsoft: `src/auth/github.ts`, `src/auth/microsoft.ts` (Microsoft converts to a walk when it next breaks)

## Connected to

- **owned-by:** the registry
- **joins:** [[site-login]] (`via`, `oauthLogin`), [[sign-in-context]], [[screen]], the OAuth consent flows (`src/browser/flows/oauth-consent.ts`)
- **looks-like-but-is-not:** `IdentityProvider` in `src/auth/identities.ts:18` (where an account lives: google or microsoft)

## If you change this

- **Hits:** `src/auth/login.ts:273-339` (`oauthLogin`, `landAfterOauth`), `src/auth/sites.ts`, `src/browser/flows/*-oauth-consent.ts`, `src/sites/wire.ts:68` (`consentProviderOf`), `test/google.test.ts`.
- **Does not hit:** `src/auth/identities.ts`; site API tokens.

## Surfaces

| Surface | Role |
|---|---|
| site logins with `via` | call `signIn` |

## See

- Source: `src/auth/providers.ts`, `src/auth/google.ts`
- Design: `designs/2026-09-27-screens.md`
