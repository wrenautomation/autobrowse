---
type: process
status: verified
verified: 2026-09-28 @ 70aefc3
consumes: [site-login, credential, sign-in-context, identity-provider, screen]
produces: [session]
---

# sign-in

A flow meets a login wall; the runner signs in with what the vault holds and tries the page again.

## Input → Movement → Output

A `FlowPage` on a wall, the site name and, when known, the account. The runner's `login` hook resolves the site's spec, picks a method (password, or a provider button), builds a `SignInContext`, runs the spec's `signIn` (a form or a walk), and answers second factors from the vault, an inbox or the phone. `signed-in` retries the open; `no-credential` or `unknown-site` hands off as `NeedsHuman`.

## Why this shape

If flows signed in themselves, every flow would carry every site's quirks and every secret path. One hook means one guard (the password is typed only on the spec's origins), one audit row per typed secret, one place a wall is recognised, and one walk per site that branches.

## Steps

1. The runner sees a wall after navigation and calls `runner.login(fp, site, account)`; a second wall while signing in is not retried — `src/browser/flow.ts:97-100,509-520`
2. `loginProvider` resolves the spec (`resolveLogin`), lists methods (`methodsOf`: password first, then each `via`) — `src/auth/login.ts:533-616,404,618`
3. `signInContext` binds the credential, the code sources and the phone notifier — `src/auth/login.ts:461`; codes: `src/auth/codes.ts:65-139`, inbox lock `:174`
4. The page is bound to the spec's origins (`boundPage`, `passwordDomains`) so a fill of the password on any other host is refused and recorded — `src/auth/guard.ts:88`, `src/auth/login.ts:380`
5. `spec.signIn(ctx)`: `formLogin` for a form (`src/auth/login.ts:193`), `oauthLogin` presses the provider button and hands to `providerOf(via).signIn` (`:272`, `src/auth/providers.ts:31`), a walk for a branching site (`googleWalk`, `src/auth/google.ts`; `walk()`, `src/browser/screens.ts:409`)
6. A method that throws `LoginFailed` yields to the next; none left → `no-credential` — `src/auth/login.ts:174,560-600`
7. The runner retries the open; a wall still there is a person's (`NeedsHuman`) — `src/browser/flow.ts:509-530`

## If you change this

- **Hits:** every spec in `src/auth/sites.ts`, `src/auth/google.ts`, `src/app/services.ts:579` (`loginFor`), compiled workflows and site browser legs (they meet walls through the same hook), `autobrowse login`, `accounts check`, `test/google.test.ts`, `test/site-fakes.ts`.
- **Does not hit:** API legs (tokens, never a wall), the engine.

## Surfaces

| Surface | Role |
|---|---|
| the runner | calls, on a wall |
| `autobrowse login <site>` (manual only, never scheduled) | calls for one site or all |

## See

- Objects: [[site-login]], [[credential]], [[sign-in-context]], [[identity-provider]], [[screen]], [[guard]]
- Source: `src/auth/login.ts`, `src/browser/flow.ts`
