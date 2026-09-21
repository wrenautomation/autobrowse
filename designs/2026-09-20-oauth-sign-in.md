# OAuth sign-in as a first-class path

William, 2026-09-20: "OAuth sign in support should be first class for
autobrowse, esp for browser automations." Two things are OAuth in a
browser automation: signing in to a site through a provider's button
("Continue with Google"), and consenting to an API client so it gets a
token. Both were ad hoc (a per-site `oauthLogin` for two sites; consent
by hand). Now both are one code path each.

## Decision

- **Providers are a registry** (`src/auth/providers.ts`): host, how the
  button reads on any site, how to sign in there. `google` today; a new
  provider is one entry plus its sign-in, never per-site code.
- **A credential can say `via`** and carry no password (`creds via
  <site> google [--url <login page>]`). Any site, spec or not, then signs
  in through the provider: the wall's page (or the stored `url`) is the
  login page, the button is found by the provider's readings, the
  provider signs in (chooser, password, TOTP, its consent), and "signed
  in" means the page is no longer a wall (`viaLogin` in `auth/login.ts`).
  A known site whose spec declares the provider keeps its own path.
- **Consent is a hand-written flow** (`google/oauth-consent`): from the
  authorize URL to the redirect, in whatever order Google shows the
  chooser, the "hasn't verified this app" warning, the scope boxes
  (sensitive scopes start unticked) and Continue. The site facade's OAuth
  setup steps run it; the loopback listener takes the code.
- **Setup steps chain through the env store**: a step's input may say
  `{ env: "GOOGLE_CLOUD_PROJECT" }`, so the client step takes what the
  project step made. A step URL in a compiled workflow may name plan
  fields (`?project={project}`).

## Proven 2026-09-20

`site setup youtube consent` walked the consent on the first run and
kept `YOUTUBE_REFRESH_TOKEN`; `site call youtube GET
/youtube/v3/channels?part=snippet,statistics&mine=true` answered over the
API leg (channel JinstersJournal). The Cloud Console side was mapped in
explore and compiled: `google-cloud-project` (keeps
`GOOGLE_CLOUD_PROJECT`), `google-cloud-oauth-client` (enable API, consent
screen, Web client with the loopback redirect, id and secret kept, test
user). Both ran once for this account; they are once-per-account flows,
not proof-run candidates.

## Where to attack (ranked)

1. Providers `github` and `microsoft`: a form sign-in each (username,
   password, TOTP) and their button readings; then any site behind
   "Continue with GitHub" is a `creds via` away. `github` built 2026-09-20
   (`src/auth/github.ts`: password → authenticator code → device
   verification email → authorize page; acts on the page the button landed
   on, never re-opens /login, so `return_to` survives); unit-tested, not
   yet proven live (needs `creds set github`, NEEDS-WILLIAM). `microsoft`
   built the same night (`src/auth/microsoft.ts`: account picker → email →
   password → authenticator code, or the phone's approve prompt through
   `notify` with the number → "Stay signed in?" → "Permissions requested");
   same status: unit-tested, unproven. Both providers fail closed
   (LoginFailed) when a page reads differently from what they expect.
   2026-09-21: the public first pages read as expected in a headless
   explore (GitHub: "Username or email address"/"Password"/"Sign in";
   Microsoft: "Enter your email, phone, or Skype."/"Next"; LinkedIn:
   "Email or phone"/"Password"/"Sign in"). Password and second steps still
   need an account.
2. Popup vs redirect: `oauthLogin` handles both, but a provider that opens
   in a popup and closes it on consent leaves `main` to land; verify on
   a site that does that (Twilio did on 2026-09-21).
3. ✅ (2026-09-21, unproven) `linkedin/oauth-consent`: feed first, then the
   authorize URL; a login shown under it (`/uas/login?session_redirect=…`)
   goes to the runner, whose `linkedin` `signInHere` signs in on that page
   and keeps the redirect; then Allow → landed. `signInToLinkedin` handles
   email/password, the checkpoint code (authenticator when a seed is
   stored, else email), and hands puzzles to a person. Needs a LinkedIn
   credential and app to prove.
4. ✅ (2026-09-20) `creds via --account ops@x.com`: `credFor(provider, account)`
   hands the provider credential for that username — the stored one when it
   matches, else `google@<label>` whose username is it (`creds set google@ops`),
   else a clear LoginFailed. `signInToGoogle` then picks that email in the
   chooser and types it on a fresh sign-in.
