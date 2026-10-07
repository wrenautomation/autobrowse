---
type: object
cluster: browser
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/browser/flow.ts
---

# Flow

One browser leg with a name and a site: `BrowserFlow<I,O>` run by the `FlowRunner` in `src/browser/flow.ts`. What a flow body gets is a `FlowPage`.

## Why this shape

Every act goes through `fp.act` with a goal in words, so the repairer, the trace, the watch, the payment gate and the secret guard all see the same thing. The runner, not the flow, owns walls (sign-in), captchas, repair, kept fixes and learned screens (`RunnerOptions`, `src/browser/flow.ts:209-242`).

## Shape

- `BrowserFlow { site, name, run(fp, input) }`; `defineFlow` — `src/browser/flow.ts:154-163`
- `FlowPage { page, passkeys, open, act, read, scroll … }` — `:92-152`; `Op` (click, fill, select, press, upload) — `:70-76`; `ActOptions { goal, irreversible, timeoutMs }` — `:78-84`
- `FlowInterrupted` (browser died: host retries whole flow) and `FlowFailed` — `:174-207`
- `RunnerOptions`: `repairer`, `pace`, `login`, `captcha`, `fixes`, `learnedScreens`, `onRepair` — `:209-261`
- The hand-written catalog: `src/browser/flows/index.ts` (OAuth consents, posts, tokens, LinkedIn reach + inbox + relationship, X reads, Reddit reads/submit/comment/message on old.reddit.com, Loom upload/rename/delete, display names on Instagram/X/TikTok/Reddit in `profile-name.ts`). `autobrowse flows [--site]` lists them all with the routes that call each, beside compiled workflows (proof state) and walks
- Feeds: `scrollCollect(fp, {read, key, max, stop?, skip?})` — `src/browser/scroll-collect.ts`: read what is on screen, scroll most of a window, keep rows by key (feeds are virtualized); ends at `max`, the cursor row, or after idle scrolls

## Connected to

- **owns:** the act path; the trace and artifacts on failure
- **owned-by:** [[app]] (`App.browser`), [[browser-service]], [[site-facade]] (browser legs), [[compiled-workflow]] (`CompiledDeps.browser`)
- **joins:** [[session]], [[hints]], [[fix]], [[screen]], [[approval]], [[guard]] (`boundPage` wraps a `FlowPage`), [[watch-step]], [[human-hands]]
- **looks-like-but-is-not:** [[workflow]] (steps and gates); a walk (a loop of screens inside a sign-in)

## If you change this

- **Hits:** every `src/browser/flows/*.ts`, `src/auth/*` sign-ins (they take a `FlowPage`), `src/compiler/render.ts` (emits `fp.act` calls), `src/explore/server.ts` (same runner), `src/auth/guard.ts:88-160`, `src/browser/watch.ts`, `src/browser/attempt.ts`.
- **Does not hit:** engine steps with no browser; the desktop leg (`src/desktop/`).

## Surfaces

| Surface | Role |
|---|---|
| runner (`flowRunner`, `src/browser/flow.ts:384`) | runs |
| explore, agent | drive a `FlowPage` one command at a time |

## See

- Source: `src/browser/flow.ts`
