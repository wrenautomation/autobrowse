---
type: object
cluster: auth
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/auth/login.ts
---

# Sign-in context

What a sign-in gets besides the page: the credential, a way to get a second-factor code, a phone note, another site's credential: `SignInContext` in `src/auth/login.ts`.

## Why this shape

Codes come from sources the site never sees (TOTP from the vault, an inbox, a phone). One inbox lock per machine (`serially`, `inboxLock`) keeps two sign-ins asking the same inbox from taking each other's code.

## Shape

- `SignInContext { fp, cred, code(kind, hint?, after?), serial?, offers(kind), inbox(kind), notify?, credFor(site, account?), as(cred) }` — `src/auth/login.ts:20-53`; built by `signInContext` — `:461`
- `CodeKind = totp | email | sms`; `CodeSource { get, offers, inbox }`; `totpSource`, `messageSource`, `codeSources`; `MessageReader` — `src/auth/codes.ts:10-139`; `inboxLock` — `:174`
- Readers: Gmail (`src/clients/gmail.ts`), the paired phone (`phoneReader`, `src/devices/phone.ts:78`), Twilio (`src/clients/twilio.ts`); wired by `codesFor` — `src/app/services.ts:539`

## Connected to

- **owned-by:** `loginProvider` (builds one per sign-in)
- **joins:** [[credential]], [[site-login]], [[identity-provider]], [[settings]] (`PHONE_NUMBER`, Twilio)
- **looks-like-but-is-not:** signup secrets (`signupSecrets`, `src/auth/signup.ts:94`: values placed by name in explore)

## If you change this

- **Hits:** every `signIn` in `src/auth/sites.ts`, `src/auth/google.ts`, `src/auth/github.ts`, `src/auth/microsoft.ts`, `src/auth/enroll.ts`, `src/app/services.ts:539-600`, `test/google.test.ts` (`ctxOf`).
- **Does not hit:** the runner, site APIs.

## Surfaces

| Surface | Role |
|---|---|
| sign-ins | read |

## See

- Source: `src/auth/login.ts:20`, `src/auth/codes.ts`
