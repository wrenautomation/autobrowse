---
type: object
cluster: build
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/recorder/types.ts
---

# Recording

The journal of acts a person or agent made, saved as a directory with `manifest.json`: `Recording` and `Action` in `src/recorder/types.ts`, stored by `src/recorder/store.ts` under `RECORDINGS_DIR` (`recordings/`, gitignored).

## Why this shape

The journal is the one input to the compiler. Typed values are redacted at capture and become secrets by name; the value is never in the file (`Action.input.redacted`, `secret`; `keep` carries only the env name).

## Shape

- `Action` kinds: navigate, desktop, click, input, select, press, upload, submit, read (as), keep (env), note, pause, resume — `src/recorder/types.ts:43-66`
- `Recording { name, site, startedAt, finishedAt, actions, trace, terminal, commands }` — `:68-80`; `RecordingSummary` — `:82-90`; `MANIFEST`, `SUMMARY` — `:100-102`
- Store: `recordingDir`, `saveRecording`, `loadRecording`, `listRecordings`, `listRecordingSummaries` — `src/recorder/store.ts:15-56`
- Captured by the in-page observer (`src/recorder/observer.ts`), the browser and terminal recorders, redaction (`src/recorder/redact.ts`)

## Connected to

- **owned-by:** the recordings dir
- **joins:** [[explore-session]] (`save`), [[agent-session]] (`save`), [[outline]] (`structure(rec)`), [[hints]], [[proposal]] (evidence)
- **looks-like-but-is-not:** a Playwright trace; a [[watch-step]] file

## If you change this

- **Hits:** `src/compiler/structure.ts:135`, `src/recorder/store.ts`, `src/explore/server.ts`, `src/agent/sessions.ts`, UI `/api/recordings` (`src/ui/api.ts:511-540`), `src/agent/builder.ts:41`.
- **Does not hit:** rendered workflows (the outline and source are their own after render).

## Surfaces

| Surface | Role |
|---|---|
| explore, agent | write |
| compiler, UI, evaluator | read |

## See

- Source: `src/recorder/types.ts`, `src/recorder/store.ts`
