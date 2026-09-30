# autobrowse as a library: layers you can take apart

2026-09-21. William: "designing autobrowse as an SDK it should expose the
full graph API + login + consent, but also the decoupled versions for
developer granularity … this applies across the whole repo … rich
optionality on what parts are our own API connections vs what parts are
autobrowse abstractions, and interesting ways of collecting / automating API
and env setup".

## Decision

One rule for the whole repo: **pure pieces, one composer per module, env
only in the composer.** A piece takes what it needs as arguments (`http`,
`env`, `sink`, `runner`, `flows`, `sites`, `llm`) and never reaches for the
process. The composer (`sitesFor`, `backendFor`, `loadSettings`, `llmFor`)
fills the defaults from the process and is what the worker and the CLI use.
A library caller calls the piece or the composer with its own parts.

Three layers, each usable alone (README "Use as a library"):

1. **Whole**: `doer` (`autobrowse/do`) — one verb over whatever abilities are
   handed to it; also the HTTP/Restate/MCP doors.
2. **Site**: `sitesFor`/`siteFacade` (`autobrowse/sites`) — the facade over a
   site list with the caller's env, sink, flows, browser.
3. **Piece**: a route's `api(input, {token, http})`; `accessTokens(http, env)`;
   `runConsent(spec, {http, env, open, port})`; a `SiteLogin`'s `signIn`;
   `consentFlow(...)`; `digest(aria)`; `exploreWithAgent(...)`.

Packaging: `package.json` `exports` map — `.`, `./sites`, `./auth`, `./do`,
`./agent`, `./flows`, `./llm` — over `dist/` from `pnpm build` (`tsc`).
Public on npm since 2026-09-30 as `@wrenautomation/autobrowse` (the bare
name was taken): the tarball is `dist/` minus compiled tests, plus README and
LICENSE. The first publish was by token; a `v*` tag publishes after that
through `.github/workflows/release.yml` (trusted publishing). The CLI's bin
runs on plain node, and it starts with no env (Restate defaults to a local
ingress).

Setup is a first-class concept, not a README: a `SetupStep` says what env
names it makes and needs and how (a recorded console flow, an OAuth
consent); `status(site).setup` says what is done, blocked or unrecorded;
`setup(site, step)` runs it into the caller's sink. That is the "collecting
/ automating API and env setup" part, and it is the same code on the box
(`autobrowse env` → SSM) and in a caller's process (their vault).

## What changed 2026-09-21

- `sitesFor` takes `sites`, `env`, `http`, `flows` (defaults: `SITES`,
  `process.env`, `httpClient()`, `BROWSER_FLOWS`).
- New entry modules: `src/do/index.ts`, `src/agent/index.ts`,
  `src/browser/flows/index.ts`; `src/sites/index.ts` and `src/auth/index.ts`
  already were.
- `test/sdk.test.ts` pins the seams: a route with a foreign token, tokens
  from a foreign env store, a facade that reads nothing from the process, the
  verb over foreign legs.

## Where to attack (ranked)

1. ✅ `doerFor(parts)` (`src/do/wire.ts`, 2026-09-21): the verb from
   catalog, browser, sink, an optional site facade and agent, with `flows`,
   `logins`, `siteApis` as options; `backendFor` is its caller. Still inside
   `backendFor`: `agentFor(settings, …)` and `compileRecording` read
   `Settings`/`COMPILED_DIR`; a caller who wants the agent over their own
   browser goes through `agentSessions({llm, dir, open})` directly.
2. ✅ `signInContext({fp, site, cred, credentials, codes})` (`src/auth/login.ts`,
   2026-09-21) is what `loginProvider` builds on a wall; a caller with their
   own `FlowPage` runs one login as `signInToGoogle(signInContext({...}))`.
   Open: a `FlowPage` over a caller's Playwright page is still built inline
   in `flowRunner`; lift it to `flowPageOf(page, {login, pace})` when someone
   needs it.
3. ✅ (2026-09-21) `pnpm build:check` (`scripts/build-check.mjs`) builds and
   imports every subpath in `exports`, naming what each must export; CI runs
   it after typecheck. Not in `gates` (a full emit per commit is not worth
   the wait).
4. ✅ `budgetedLlm(llm, {dailyTokens, ledger})`, `fileLedger`, `memoryLedger` are
   exported from `autobrowse/llm` (2026-09-21); `llmFor(settings)` is their
   composer.
5. ✅ Each entry module opens with a line saying what it is for; a generated
   API listing is not worth it yet.
