# Big files split by job (2026-10-24)

## Goal

No source file over ~1200 lines with several reasons to change. A split is a pure move: the same names exported from the same path, typecheck and unit tests green before and after, map cards repointed in the same commit. (Principles: wren `designs/2026-10-24-code-quality-handoff.md`.)

## `src/app/services.ts` (1999 lines): done

- Every top-level statement moved to one sibling by the job its section comment names: `services-browser.ts` (profiles, runner options, the traced model, workflow lists), `services-state.ts` (identities, credentials, ledgers, dirs, shots and traces, timers), `services-signin.ts` (walks, watchers, phone, codes, logins, pace), `services-money.ts` (wallet, profiles, files, cards, charges), `services-keys.ts` (SSM client, env store, keys, memory), `services-reach.ts` (Google, approver, spend, channels), `services-workflows.ts` (each hand-written workflow's deps), `services-kit.ts` (`required`, `lazy`).
- `services.ts` stays the public face: `App`, `buildApp` and an explicit re-export of every name that was exported before; nothing new exported. The 26 importers and the tests did not change. Four helpers siblings share became exports of their own file (`ssmFor`, `noticeFor`, `required`, `lazy`).
- Done by an ~120-line AST script (TypeScript's parser) that assigned statements, computed each file's imports from the original list, and added sibling imports; thrown away after, as the handoff says. Map citations repointed by the symbol named next to them (28), else by line.

## `src/explore/server.ts` (2088 lines): planned, not split

- The file is two things: the command grammar and small pure helpers (lines 137–470, 576–680, 710–790: `commandSchema`, the `LOOKS`/`UNBATCHABLE`/`LOOKED_AT` sets, `placeHint`, `shortUrl`, `pageChange`, `leanUrls`, the journal and token file helpers, `runDesktop`, `serve`) and one 1340-line function, `startExplore`, whose `act` switch (500 lines) closes over some forty locals.
- Step 1 (pure move, safe): `explore/commands.ts` (schema, `Command`, the sets), `explore/journal.ts` (`journalFileFor`, `readJournal`, `tokenFileFor`, `Journaled`), `explore/serve.ts` (`serve`, `runDesktop`). `server.ts` re-exports them; ~600 lines leave.
- Step 2 (not a pure move): `startExplore` needs a context object (`page`, `journal`, `gate`, `out`, the run log) before `act`'s cases can move out by command family (look, act, place, files, desktop). That changes how the closure's state is shared and needs the explore and teach tests run live; not done in this sweep.
- A file-size gate (`git ls-files | xargs wc -l`, none over 1200) goes into `pnpm lint` once step 2 is in; until then `server.ts` would fail it.

## Decision log

- 2026-10-24: flat siblings with a `services-` prefix, not a `src/app/services/` folder: NodeNext resolves `./services.js` to a file, not a folder index, so the barrel must stay a file; a prefix keeps the eight files found together in `src/app`.
- 2026-10-24: explicit `export { … } from` lists, not `export *`: the four helpers exported for siblings must not become public.
