# Operator defaults: no Wren value in code, Wren by default for us

2026-10-24. William: "make sure it's not hardcoded, but it's still default for us to Wren values"; "compiled workflows need to work by default for us, but are sharable, and the compile resolves to such workflows predictably so we don't have to do post-edits"; a marketplace is not needed now, "but we need to support that for the future".

## Goal

Every workflow and browser flow in the package names no person, account or company. Wren's values reach them as defaults from Wren's own config, which the package and the registry never carry. The compiler produces such a workflow on the first pass, and a check refuses one that does not.

## Target state

1. **Plan defaults per workflow.** `<plansDir>/<workflow>.json` holds the owner's default plan. `plansDir` is a setting (`PLANS_DIR`, default `~/.config/autobrowse/plans`; an owner's is `owners/<owner>/plans`). Every start merges `{ ...saved, ...given }`: `autobrowse run`, `autobrowse try` (and `--prove`), the UI's Run and Prove. `autobrowse workflows <name>` marks each field that has a saved default. The file is the person's: a compile writes it once and never overwrites it.
2. **The compiler writes two things.** The source, which names no one, and the owner's plan file, which holds every value the recording typed. A `// e.g.` comment keeps an example only when it passes `redactPii` unchanged. A locator hint (`name`, `text`, `placeholder`) that contains a typed value, or the account's own username, reads `{field}` and renders as a template, the same way a step URL does (`URL_FIELD`). The account's username becomes the plan field `account` when a hint needs it.
3. **The lint is code, not a prompt.** `src/compiler/lint.ts` finds personal data in an outline and in rendered files (`redactPii` patterns, plus the recording's known values). `compile` reports it, a `finish` round fails on it, the registry gate refuses on it (already did, via `redactPii`), and the repo's test suite runs it over every hand-written workflow and browser flow. One rule, four places.
4. **Operator values are settings.** New optional settings, none with a Wren default: `operatorName` (the business name on consent screens and signups), `operatorHandle`, `oauthRedirectUrl`, `appOrigin`, `linkedinPage`. `credLinkUrl` loses its default. The operator's own account profiles are `<site>@<operator>` by convention (`x@wren` is `x@${operator()}`), so `intuit@wren` and `jobber@wren` become that expression. The card holder's name comes from the billing profile, not a literal. Needs that only exist for an operator with a name and handle (signups, the Page link) appear only when those settings are set.
5. **Sharing stays as it is.** Each hand-written workflow already ships in the npm package; compiled ones go through `share` → gate → `share approve` (William's yes) → the public registry → `autobrowse workflows add`. With 1-4 in place every one of them can go, because none names anyone. A browsable catalog is future work and needs no change here: `index.json` in the registry is the catalog.

## Not now

- A marketplace page or search. The registry and `workflows add` are the seam; a page reads `index.json` when wanted.
- Pushing our packs through the gate. That is one `share` run per pack plus William's `share approve`, separate from this change.
- `auth/uwaterloo.ts` and `learn.ts`: one university's D2L. Operator-specific by nature, left as is.

## Decision log

- Plan file over `.default()`: a default in code ships in the package; a file in `~/.config` does not. The 7 `.private` flows were the expedient version of this and are gone (13f0fc0).
- Compile writes the plan file: the typed values must land somewhere or the person retypes them; the plan file is where every start already reads. No post-edit.
- Hints use `{field}` like URLs: one placeholder convention, one interpolation path, no schema change.
- Lint in code over a prompt rule: the prompt rule in `finish.ts` was advice; a model can miss it. `checkCompiled` fails the round instead.
- `redactPii` as the pattern set: it is what the registry gate already judges by. A handle with no PII shape (`wrenautomation`) is not caught by pattern; the known-values pass (typed values, the account's username) covers the identity case, and `share approve` is still a person's read.
- Settings over an `operator() === "wren"` branch: a branch is a Wren literal by another name. A fresh install has no OAuth app, so a site that needs `oauthRedirectUrl` says so instead of pointing at Wren's.
- Every typed example leaves the outline, not only the PII-shaped ones (10-24, after the first cut): a handle has no PII shape and is still the operator's. The plan file holds all of them; the compiled module has no `// e.g.`; `workflows <name>` prints `saved <value>` from the plan file. Predictable: one rule, no judgement call per value.
- `{ env: NAME }` markers for site literals (`WEB_REDIRECT`, `TIKTOK_REDIRECT`, the connectors' `origin`, `appName`, the Cloud project name): site modules load before `boot()` reads the env, so a module-scope setting read would see nothing. A marker resolves at call time, where the facade already resolves `SetupInput` markers. `redirectOf` and `originOf` are the two readers.
- Two redirect settings, not one: Meta's apps and TikTok's register different URIs; one setting would make a fresh operator register the same path on both.
- Lint scope: `index.ts` and `outline.json` by every pattern; `index.test.ts` only by the known values (its fake addresses are its own). Documentation shapes (RFC 5737 IPs, `example.com`, `.test`, `Chrome/129.0.0.0`, long digit-free names, `__` names) are not personal.
- Merge order at every start: `plans.get(name)` → under the given plan → `shipPlanFiles` → the workflow's schema. The CLI, the UI (`safeParse` → 400) and `prove` share `withDefaults`; a compile `put`s with `keep: true`, so a hand edit to the plan file survives a recompile.
- `LINKEDIN_PAGES` as `handle=id,…`: the comment flow needs handle → id, the composer needs the id set, the audience flow needs one default. One env value feeds all three; the first Page is the default.
- `test/no-personal.test.ts` reads the operator's values from the repo `.env` through `loadEnvFile` (values stay in the process): on this Mac it checks Wren's values, on CI (no `.env`) the PII shapes only. It walks `outline.json` too: the outline is published with the module.
- `run <wf> <key>` with no `--plan` resumes (a null plan is the resume signal, unchanged); a start always passes `--plan`, and the saved defaults merge under it. `try` has no resume, so it merges always.
- `<site>@<operator>` as the convention for the operator's own profiles: the role name is the operator name already (`AUTOBROWSE_CRED_LINKEDIN__WREN_*`).
