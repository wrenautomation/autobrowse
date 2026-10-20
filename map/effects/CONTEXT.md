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
| an Exa key, `NUM_EXA`, or the out-of-credit rule | `src/reach/key-ring.ts`, `src/reach/key-source.ts` (the vault is the source; the env names are its projection, `creds key`) | [[credential]], `web`'s Exa routes and `exa` cap (`capsPerKey`, [[site-api]]), `spent-keys.json` in [[state-files]], `doctor`'s `exa live/held`, owner env (`EXA_API_KEY_*` is the operator's) |
| token names, renewal, the env store | [[token]] | [[site-facade]], wren `TokenRenewal` |
| accounts and purposes | [[account]] | [[site-facade]] (which account runs), [[need]], `Policy` |
| the compiler's output | [[compiled-workflow]] | [[outline]], [[proof]], [[heal]] process, `src/index.ts` exports |
| the explore command set | [[explore-session]] | `.claude/skills/autobrowse/`, [[agent-session]] |
| a run row, the `goal`/`done` commands | [[explore-run]] | [[walk-spec]] (build reads acts and looks), [[llm-call]] (`tokens` reads `cmd` rows), `.claude/skills/autobrowse/explore.md` |
| a walk's spec or how one is built, taught or run | [[walk-spec]] | [[screen]] (`walk()`), [[outline]] (op schemas), [[mod]] (`packInto`, the scrubber), [[explore-session]] (hand looks), [[card]] (`profileField`, src/money/profile.ts), walk files on disk (`WALK_VERSION`) |
| a mod's format, pack scrubber, or how installed mods load | [[mod]] | [[walk-spec]] (`loadWalk`, `listWalks`), [[screen]], [[fix]] (`from`, `keep`), [[site-login]] (`siteAllowsHost`, data logins in `SITE_LOGINS`), [[compiled-workflow]] (trusted roots in `compiledCatalog`), the UI Mods page (`ModView`), mods already installed (`modSchema`) |
| what is counted per model call | [[llm-call]] | every `purpose` caller, `src/runs/tokens.ts`, `src/runs/success.ts` |
| what a site call's try records | [[site-call-ledger]] | [[site-call]] (`sitesService`), `src/runs/success.ts`, `src/runs/import.ts` |
| what spends and who says yes | [[approval]] | [[spend-policy]], [[card]], [[site-api]] `spends` |
| a stored file (paper or doc), its sets, upload or text | [[file]] | [[explore-session]] (`uploadFiles`, `read_file`), [[approval]] (a paper's yes), wren `apps/phone` drops |
| a state file's path or format | [[state-files]] | the owning card |
| the `./mail`, `./google` or `./oauth` exports, a piece's `fetch` or login shape, a providers-table URL, or its allowed imports | [[mail-piece]], [[google-piece]], [[oauth-piece]] | `test/pieces.test.ts`, `scripts/build-check.mjs`, `package.json` `exports`, [[sign-in-context]] (Gmail code reader), `gmailFor` in `src/app/services.ts` |
| an env variable | [[settings]] | `compose.yml`, `deploy/prod.env.example`, `README.md` |
| the backend port | [[backend]] | `src/ui/api.ts`, the SPA client `ui/src/api.ts`, CLI client |
| `do` routing, the catalog | [[ability]] | [[access-key]] (scope cuts), [[do]] process, wren callers |
| the track session format, install code, or bucket layout | [[autotrack-session]] | `autotrack src/events.ts`, `autotrack src/config.ts`, `autotrack src/ship.ts`, autotrack `install/*`, `deploy/terraform/track.tf`, [[recording]] (`desktop` acts, `intent`), [[settings]] (`TRACK_BUCKET`) |
| the heartbeat body or fleet health (silent rule, Discord post, `autotrack-health.json`) | [[autotrack-session]] | the recorder (writes it), `src/autotrack/{heartbeat,health}.ts`, `src/app/cli-autotrack.ts` (`devices`), `src/app/main.ts` (desk timer), `test/autotrack-heartbeat.test.ts` |
| the offline labels and RL steps (join, signals, episodes, label prompt, `labels/` and `steps/` keys, quality score) | [[autotrack-session]] | `src/autotrack/{join,signals,episodes,label,label-run,steps,steps-run,tree,quality,pool}.ts`, `src/autotrack/import.ts` (`intent` on actions), `src/app/cli-autotrack.ts`, `test/autotrack-signals.test.ts`, `test/autotrack-label.test.ts`, `test/autotrack-steps.test.ts` |
| an owner's names, paths, or setting classes | [[owner]] | [[state-files]], [[settings]], [[runs-registry]], `deploy/terraform/owners.tf` (the `owner` tag) |

## Pointing in (outside this tree; breaks silently)

| From | Into | How it breaks |
|---|---|---|
| wren `packages/core/src/content/restate.ts` and its channel packages | Restate services `sites` (`call`, `status`, `setup`), `desk` (same handlers, the Mac), `do`, `browser` | a renamed service or handler, a changed route path or input shape |
| wren `packages/core` Accounts rows (copied types) | the `keys`, `keySpend`, `keyRevoke` and `keyRotate` handlers on `sites` and `desk`: shapes `KeyRow`, `KeysAnswer`, `KeyRevokeAnswer`, `KeyRotateAnswer` (`src/sites/keys.ts`) | a renamed handler or a changed field of a shape: the Accounts page shows the wrong row or fails to parse; a value in an answer would leak a key |
| wren `send_attempts` and the send paths (outreach, content, ContentScheduler) | `sites/call` and `desk/call` with `sendKey`, and `sites/verdict` and `desk/verdict` `{sendKey}`; the result `SendVerdict` (`src/sites/verdict.ts`: `sent`, `not_sent`, `unknown`) | wren reads error words instead of the verdict; the caller sets no `sendKey`, or a Restate idempotency key that differs from it; the caller reads `verdict` on a different service than the one that ran the call (each machine keeps its own journal); a changed `SendVerdict` field |
| wren `Enrichment.render` (`packages/research/src/enrichment/render.ts`) | `web GET /fetch` on `sites` or `desk`: params `url`, `from`, `max`; the `Fetched` answer (`html`, `finalUrl`, `status`, `type`, `cut`, `tier`, `block`, `tries`); tier and block names in `src/reach/ladder.ts` | a renamed param, tier or block name, a changed `Fetched` field |
| wren `packages/core/src/ask.ts` (`Ask/answer`) | Restate service `claude` (`ask`: question, system, dir, also, commands, model) on the desk | a renamed handler or input field, the desk off (asks wait in Restate) |
| wren `channel-email` inbox sync and mailbox code (from 2026-10-20) | `./mail` and `./google` (`src/mail/index.ts`, `src/google/index.ts`): `ImapReader`, `RoutedReader`, `InstantlyReader`, `GmailClient`, `serviceAccountToken`, `loadServiceAccountKey` | a renamed or removed export, a changed constructor or `FetchLike` shape, a browser or app import (`test/pieces.test.ts` fails first) |
| wren OAuth sign-in: `core/oauth`, social connect, mail access, connectors (from 2026-10-20) | `./oauth` (`src/oauth/index.ts`): `tokenPost`, `exchangeCode`, `refreshGrant`, `metaUserToken`, `metaPages`, `whoAmI`, `mailExchange`, `mailRefresh`, `appExchange`, `appRefresh`, `authorizeUrl`, `OAUTH_PROVIDERS` | a changed URL, header, form field or error `code` in any call (wren's wire must stay the same), a renamed export, a browser or app import (`test/pieces.test.ts` fails first) |
| wren `TokenRenewal`, credvault `syncedEnvStore` | SSM `/autobrowse/config` names (`accountEnv`) | a renamed token or account suffix |
| `.claude/skills/autobrowse/scripts/*.sh` | `pnpm -s autobrowse explore` and the explore command set | a renamed CLI verb or command field |
| `src/workflows/*/index.ts` (rendered) | `src/index.ts` exports (`COMPILED_LIB`) | an export removed or renamed |
| `Dockerfile` | `src/app/main.ts`, env names | a moved entry file or a renamed variable |
| `deploy/desk/install.sh` (launchd on the Mac) | `src/app/desk.ts`, `node_modules/tsx/dist/cli.mjs` | a moved entry file or tsx's cli path |
| `deploy/desk/update.mjs` (launchd, every minute) | the `desk up` log line in `src/app/desk.ts`, the desk label | a renamed log line: every deploy pings #ops as failed |
| `wrenCheckout` (`src/studio/service.ts`) | `../wren-desk` kept on origin/main by `update.mjs`; wren's prod CLI script | no `wren-desk`: calls fall back to the main `wren` checkout, which may be behind or mid-edit |
| `deploy/terraform/` local state (never committed) | the box, CI role, shots bucket | a second machine has no state; read before apply |
| `track/` (autotrack, own package) | `src/autotrack/types.ts` (copied `Event`), `src/autotrack/code.ts` (install code), the key layout in `src/autotrack/store.ts` | a changed event field, code field or S3 key: import reads nothing or the wrong thing, a device's put is denied |
| `NEEDS-WILLIAM.md` (hand-kept) | mirrors `autobrowse needs` | drift when a need clears in code but not in prose |
