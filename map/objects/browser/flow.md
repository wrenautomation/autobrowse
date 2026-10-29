---
type: object
cluster: browser
universe: live
status: verified
verified: 2026-10-20 @ HEAD
entity: src/browser/flow.ts
---

# Flow

One browser leg with a name and a site: `BrowserFlow<I,O>` run by the `FlowRunner` in `src/browser/flow.ts`. What a flow body gets is a `FlowPage`.

## Why this shape

Every act goes through `fp.act` with a goal in words, so the repairer, the trace, the watch, the payment gate and the secret guard all see the same thing. The runner, not the flow, owns walls (sign-in), captchas, repair, kept fixes and learned screens (`RunnerOptions`, `src/browser/flow.ts:209-242`).

## Shape

- `BrowserFlow { site, name, run(fp, input) }`; `defineFlow` — `src/browser/flow.ts:192-215`
- `FlowPage { page, passkeys, open, act, read, scroll … }` — `:121`; `Op` (click, fill, select, press, upload) — `:89`; `ActOptions { goal, irreversible, timeoutMs }` — `:107`
- `FlowInterrupted` (browser died: host retries whole flow) and `FlowFailed` — `:241`, `:265`
- `RunnerOptions`: `repairer`, `pace`, `login`, `captcha`, `fixes`, `learnedScreens`, `onRepair`, `done`, `runs`, `resume` — `:276-342`
- Resume: a keyed run (`withCall`) that stops keeps its page; the next try's first `fp.open` goes there — `:568`, `:922`, `:982` ([[resume-record]])
- The hand-written catalog: `src/browser/flows/index.ts` (OAuth consents, posts, tokens, LinkedIn reach + inbox + relationship, X reads, Reddit reads/submit/comment/message on old.reddit.com, Loom upload/rename/delete, display names on Instagram/X/TikTok/Reddit in `profile-name.ts`). `autobrowse tools <site>` lists them as workflows (`<site>-<name>`) with the routes that call each, beside compiled workflows (proof state) and walks. Outside a workflow's step a leg runs through `runLeg` (`engine/leg.ts`): a one-step engine run in the engine ledger
- Feeds: `scrollCollect(fp, {read, key, max, stop?, skip?})` — `src/browser/scroll-collect.ts`: read what is on screen, scroll most of a window, keep rows by key (feeds are virtualized); ends at `max`, the cursor row, or after idle scrolls

## Connected to

- **owns:** the act path; the trace and artifacts on failure
- **owned-by:** [[app]] (`App.browser`), [[browser-service]], [[site-facade]] (browser legs), [[compiled-workflow]] (`CompiledDeps.browser`)
- **joins:** [[session]], [[hints]], [[fix]], [[screen]], [[resume-record]], [[approval]], [[guard]] (`boundPage` wraps a `FlowPage`), [[watch-step]], [[human-hands]]
- **looks-like-but-is-not:** [[workflow]] (steps and gates); a walk (a loop of screens inside a sign-in)

## If you change this

- **Hits:** every `src/browser/flows/*.ts`, `src/auth/*` sign-ins (they take a `FlowPage`), `src/compiler/render.ts` (emits `fp.act` calls), `src/explore/server.ts` (same runner), `src/auth/guard.ts:88-160`, `src/browser/watch.ts`, `src/browser/attempt.ts`.
- **Does not hit:** engine steps with no browser; the desktop leg (`src/desktop/`).

## Surfaces

| Surface | Role |
|---|---|
| runner (`flowRunner`, `src/browser/flow.ts:464`) | runs |
| explore, agent | drive a `FlowPage` one command at a time |

## See

- Source: `src/browser/flow.ts`
