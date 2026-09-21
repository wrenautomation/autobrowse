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
Still `private: true`: wren takes it as a workspace/git dependency, nothing
goes to npm.

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

1. `backendFor(settings, app, o)` still builds its parts from `Settings`
   inside (`explorerOpener`, `agentSessions`, the compiler); a caller who
   wants the agent with their own browser has to go under it. Split it into
   `agentFor(parts)`, `compilerFor(parts)`, `doerFor(parts)` composers and
   keep `backendFor` as the sum.
2. `SiteLogin.signIn` takes a `SignInContext` the runner builds (`fp`, `cred`,
   `code`, `inbox`); expose `signInContext({page, credential, codes})` so a
   caller with their own Playwright page can run one login.
3. Publish flow: `pnpm build` is not in gates and `dist/` is not proven by
   a consumer; add a smoke test that imports `dist/sites/index.js` after a
   build (CI only).
4. `llmFor(settings)` reads the budget file path and the provider from
   settings; a caller passing an `Llm` of their own already works
   (`DoerDeps.llm`), but the budget ledger is not reusable on its own.
5. Docs per subpath: a short header comment in each entry module says what
   it is for; a generated API listing is not worth it yet.
