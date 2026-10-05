---
type: object
cluster: build
universe: live
status: verified
verified: 2026-10-04 @ mods
entity: src/mods/mod.ts
---

# Mod

What autobrowse learned about a site, packed for another owner or install: `mod.json` plus data files the existing interpreters read (walks, learned screens, fixes, logins), or code (a compiled workflow) that loads only when added with `--trust`. Installed under the owner's state as `mods/<dir>/`; shared through npm (keyword `autobrowse-mod`), published by hand only.

## Why this shape

Data kinds first: their interpreters exist and can't run new code. The owner's own files always win, so installing a mod never breaks a flow that works. A mod's screen or fix that works is copied into the owner's file with `from`, so removing the mod keeps it. A data login can't replace a built-in, and its home and origins must carry the site's own name, so it can't widen where a stored password goes.

## Shape

- `KIND_DIRS`, `CODE_KINDS` (workflow) — `src/mods/mod.ts:20`, `:30`; `modSchema` (name, version, `autobrowse` `>=x.y.z`, sites, domains, gates, `site:role` credentials, irreversible, files with sha256) — `:40`; `modScreenSchema`, `modFixSchema` — `:92`, `:101`
- Load: `installedMods` (`trusted` from `installed.json`) — `:140`; `modScreens`, `modFixes` — `:174`, `:185`; `modWorkflowRoots` (trusted only) — `:196`; `withModScreens`, `withModFixes` (owner first, copy on use) — `:205`, `:225`; walks: `modWalkDirs`, `loadWalk`, `listWalks` (`mod` on a listing) — `src/walks/spec.ts:162-201`
- Logins as data: `dataLoginSchema` (formLogin or oauthLogin inputs, regexes as strings) — `src/mods/login.ts:48`; `loginOf` — `:86`; `loginProblems` (no built-in, in domains, carries the site's name) — `:113`; `dataLogins`, `registerDataLogins` (owner's `logins/*.json`, then mods') — `:133`, `:157`; `addSiteLogins`, `builtInLogin` — `src/auth/sites.ts:888-896`
- Wiring: `modsDirFor`, `loginsDirFor`, `loadDataLogins` (cli.ts and `buildApp`, after `boot()`), `screensFor`, `fixesFor` — `src/app/services.ts:583-597`; mod workflow roots into `compiledCatalog` — `:1428`, `src/app/backend.ts:346`
- Add: `checkMod` (schema, version, hashes, hosts in domains, irreversible needs send or purchase, secrets only on a named page their site's password may go, logins via `loginProblems`, code needs `trust`) — `src/mods/install.ts:93`; `searchMods` (registry search, `autobrowseMod` per hit) — `:233`; `fetchMod` (dir, tgz, `npm pack --ignore-scripts`) — `:264`; `installMod` copies listed files only, a code mod passes `checkCompiled` first (shim `index.ts`, node_modules link, tsconfig) — `:326`; `removeMod` — `:361`
- Pack: `Scrubber` (masks addresses and stored usernames, drops query, fragment, examples, run ids, dirty landmarks and hints; a dirty literal becomes a plan field) — `src/mods/pack.ts:49`; final refusal on any stored value or address — `:110`; `scrubLogin` — `:184`; `packMod` — `:205`; `scrubFrom` reads the store unarmed — `:366`
- CLI: `autobrowse mods pack|search|add|list|remove` — `src/app/cli-mods.ts`
- Mods page: `modsPort` (list with permission lines, walks' flow names and kept screens and fixes; search; check then add, data only; remove) — `src/mods/install.ts:401`; `Backend.mods` — `src/app/backend.ts:149`, `:460`; `/api/mods` routes — `src/ui/api.ts:401-451`; `ui/src/pages/Mods.tsx`
- Sample: `walkthrough/mods/autobrowse-mod-scratch` (0.2.0 on npm, taught by hand and packed by `teach --mod`; biome skips it so its hashes hold). `packInto` (`src/walks/teach.ts`) sets `autobrowse` to `>=` the packing version

## Connected to

- **owns:** `<state>/mods/<dir>/` (`mod.json`, `installed.json`, listed files)
- **owned-by:** the owner's state dir ([[state-files]])
- **joins:** [[walk-spec]], [[screen]], [[fix]], [[site-login]] (`siteAllowsHost`, data logins), [[compiled-workflow]] (trusted code kind), [[credential]] (scrubber reads values, never writes them)
- **looks-like-but-is-not:** the autobrowse npm package itself

## If you change this

- **Hits:** `src/walks/spec.ts` (walk loading), `src/app/services.ts` (runner stores, data logins, compiled catalog), `src/auth/sites.ts` (`SITE_LOGINS` grows at start), `src/app/cli-auth.ts` (login check screens), mods already installed (`modSchema`).
- **Does not hit:** the owner's own files (never merged into, except a used screen or fix); gates and guards (a mod's flows run under the same ones).

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse mods pack` | writes a mod folder |
| `autobrowse mods search` | reads the npm registry |
| `autobrowse mods add/remove` | writes `<state>/mods/` |
| UI Mods page (`/api/mods`) | reads; adds data mods, removes |
| runner, `walks run`, `walks list`, `catalog`, `SITE_LOGINS`, `Compiled` | read |

## See

- Source: `src/mods/`
- Design: `designs/2026-10-04-mods.md`
