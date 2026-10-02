# effects/ — what a change hits

Open the row for the thing you are about to change. Each row names the cards that carry the first-order waterfall; the card's `If you change this` has the file list. Rows are by the question, not the folder.

| Changing | Open first | Then |
|---|---|---|
| a step's shape, plan schema, `settle` | [[workflow]] | [[run-object]], `src/compiler/render.ts` (rendered modules must still match) |
| gate names, guards, how an answer applies | [[gate]] | [[run-event]], [[channel]] (reply parser), UI runs page |
| retry policy, run state keys | [[run-object]] | [[runs-registry]], the test host `src/engine/memory.ts` |
| anything on the act path (`fp.act`, ops, timeouts) | [[flow]] | [[hints]], [[fix]], [[guard]], [[watch-step]], [[approval]], every hand-written flow and rendered module |
| how a control is named | [[hints]] | [[recording]], [[outline]], [[fix]], [[screen]], the observer script |
| a walk, a screen's `looks` | [[screen]] | [[identity-provider]] (Google), [[site-login]] (Cloudflare), `test/site-fakes.ts` |
| where the browser runs (tiers, profiles, own browser) | [[session]] | [[settings]], [[state-files]] (`profiles/`), reap |
| a credential name or the vault | [[credential]] | [[account]], [[sign-in-context]], [[need]], wren (same SSM path) |
| a site's sign-in | [[site-login]] | [[sign-in]] process, `accounts check`, [[need]] |
| a provider sign-in (Google, GitHub, Microsoft) | [[identity-provider]] | every site with `via`, OAuth consent flows |
| an official API route or setup step | [[site-api]] | [[site-facade]], [[token]], [[ability]], [[need]], wren callers by path |
| a site's daily caps or a route's meter | [[site-api]] | [[site-facade]] (429 + `retryAfter`), `caps.json` in [[state-files]], wren callers that back off |
| token names, renewal, the env store | [[token]] | [[site-facade]], wren `TokenRenewal` |
| accounts and purposes | [[account]] | [[site-facade]] (which account runs), [[need]], `Policy` |
| the compiler's output | [[compiled-workflow]] | [[outline]], [[proof]], [[heal]] process, `src/index.ts` exports |
| the explore command set | [[explore-session]] | `.claude/skills/autobrowse/`, [[agent-session]], `src/mcp/server.ts` |
| a run row, the `goal`/`done` commands | [[explore-run]] | [[walk-spec]] (build reads acts and looks), [[llm-call]] (`tokens` reads `cmd` rows), `.claude/skills/autobrowse/explore.md` |
| a walk's spec or how one is built or run | [[walk-spec]] | [[screen]] (`walk()`), [[outline]] (op schemas), walk files on disk (`WALK_VERSION`) |
| what is counted per model call | [[llm-call]] | every `purpose` caller, `src/runs/tokens.ts` |
| what spends and who says yes | [[approval]] | [[spend-policy]], [[card]], [[site-api]] `spends` |
| a state file's path or format | [[state-files]] | the owning card |
| an env variable | [[settings]] | `compose.yml`, `deploy/prod.env.example`, `README.md` |
| the backend port | [[backend]] | `src/ui/api.ts`, the SPA client `ui/src/api.ts`, CLI client |
| `do` routing, the catalog | [[ability]] | [[access-key]] (scope cuts), [[do]] process, wren callers |
| an owner's names, paths, or setting classes | [[owner]] | [[state-files]], [[settings]], [[runs-registry]], `deploy/terraform/owners.tf` (the `owner` tag) |

## Pointing in (outside this tree; breaks silently)

| From | Into | How it breaks |
|---|---|---|
| wren `packages/core/src/content/restate.ts` and its channel packages | Restate services `sites` (`call`, `status`, `setup`), `desk` (same handlers, the Mac), `do`, `browser` | a renamed service or handler, a changed route path or input shape |
| wren `TokenRenewal`, credvault `syncedEnvStore` | SSM `/autobrowse/config` names (`accountEnv`) | a renamed token or account suffix |
| `.claude/skills/autobrowse/scripts/*.sh` | `pnpm -s autobrowse explore` and the explore command set | a renamed CLI verb or command field |
| `src/workflows/*/index.ts` (rendered) | `src/index.ts` exports (`COMPILED_LIB`) | an export removed or renamed |
| `Dockerfile` | `src/app/main.ts`, env names | a moved entry file or a renamed variable |
| `deploy/desk/install.sh` (launchd on the Mac) | `src/app/desk.ts`, `node_modules/tsx/dist/cli.mjs` | a moved entry file or tsx's cli path |
| `deploy/terraform/` local state (never committed) | the box, CI role, shots bucket | a second machine has no state; read before apply |
| `NEEDS-WILLIAM.md` (hand-kept) | mirrors `autobrowse needs` | drift when a need clears in code but not in prose |
