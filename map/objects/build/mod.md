---
type: object
cluster: build
universe: live
status: verified
verified: 2026-10-04 @ mods
entity: src/mods/mod.ts
---

# Mod

What autobrowse learned about a site, packed for another owner or install: `mod.json` plus data files the existing interpreters read (walks, learned screens, fixes). Installed under the owner's state as `mods/<dir>/`; shared through npm (keyword `autobrowse-mod`), published by hand only.

## Why this shape

Data kinds first: their interpreters exist and can't run new code. The owner's own files always win, so installing a mod never breaks a flow that works. A mod's screen or fix that works is copied into the owner's file with `from`, so removing the mod keeps it.

## Shape

- `modSchema` (name, version, `autobrowse` `>=x.y.z`, sites, domains, gates, `site:role` credentials, irreversible, files with sha256) — `src/mods/mod.ts:31`; `modScreenSchema`, `modFixSchema` — `:72`, `:81`
- Load: `installedMods` — `:118`; `modScreens`, `modFixes` — `:151`, `:162`; `withModScreens`, `withModFixes` (owner first, copy on use) — `:176`, `:196`; walks: `modWalkDirs`, `loadWalk`, `listWalks` (`mod` on a listing) — `src/walks/spec.ts:162-201`
- Wiring: `modsDirFor`, `screensFor`, `fixesFor` — `src/app/services.ts:576-583`
- Add: `checkMod` (schema, version, hashes, hosts in domains, irreversible needs send or purchase, secrets only on a named page their site's password may go, `siteAllowsHost`) — `src/mods/install.ts:80`; `fetchMod` (dir, tgz, `npm pack --ignore-scripts`) — `:191`; `installMod` copies listed files only — `:219`; `removeMod` — `:239`
- Pack: `Scrubber` (masks addresses and stored usernames, drops query, fragment, examples, run ids, dirty landmarks and hints; a dirty literal becomes a plan field) — `src/mods/pack.ts:48`; final refusal on any stored value or address — `:109`; `packMod` — `:182`; `scrubFrom` reads the store unarmed — `:327`
- CLI: `autobrowse mods pack|add|list|remove` — `src/app/cli-mods.ts`

## Connected to

- **owns:** `<state>/mods/<dir>/` (`mod.json`, `installed.json`, listed files)
- **owned-by:** the owner's state dir ([[state-files]])
- **joins:** [[walk-spec]], [[screen]], [[fix]], [[site-login]] (`siteAllowsHost`), [[credential]] (scrubber reads values, never writes them)
- **looks-like-but-is-not:** a [[compiled-workflow]] (code; not a data kind); the autobrowse npm package itself

## If you change this

- **Hits:** `src/walks/spec.ts` (walk loading), `src/app/services.ts` (runner stores), `src/app/cli-auth.ts` (login check screens), mods already installed (`modSchema`).
- **Does not hit:** the owner's own files (never merged into, except a used screen or fix); gates and guards (a mod's flows run under the same ones).

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse mods pack` | writes a mod folder |
| `autobrowse mods add/remove` | writes `<state>/mods/` |
| runner, `walks run`, `walks list`, `catalog` | read |

## See

- Source: `src/mods/`
- Design: `designs/2026-10-04-mods.md`
