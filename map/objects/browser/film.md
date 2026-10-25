---
type: object
cluster: browser
universe: live
status: verified
verified: 2026-10-24 @ a5aeff6
entity: src/browser/film.ts
---

# Film

A run recorded as a take for a product video: each page as an mp4 pane, plus every pointer move, click and key on the same clock. `filmContext` and `filmPage` in `src/browser/film.ts`; the tape director in `src/film/director.ts` (designs/2026-10-24-film.md).

## Why this shape

Filming is a session option, so every runner films with no change (`AUTOBROWSE_FILM=<dir>`). The cursor, zooms and sounds are not filmed: an editor (wren's studio) draws them from the log at its own frame rate.

## Shape

- `filmPage(page, dir, kind, size)` — `src/browser/film.ts:196`: fits the window (`fitWindow`, `:290`), screencasts JPEGs at 2x, writes `<pane>.json` (`filming: true` until done), encodes `<pane>.mp4` on stop (`encode`, `:347`: VFR on a 1/60 s clock, `-bf 0`)
- `filmContext` — `:383`: films each page of a context; the session sets `Session.filmed` (`src/browser/session.ts:145`), and the trace then takes no screenshots
- Events from the hands: `HandsLog` (`src/browser/human/index.ts:147`) fed by `filmLog`; `FILM_PACE` (`:111`) whenever a film is on (`paceFor`, `src/app/services-signin.ts:294`)
- `filmTape` — `src/film/director.ts:38`: ttyd in headless Chrome as the `term` pane; `wait` counts only output after the last key (`showsAnew`, `:149`); writes `take.json`
- Needs: `FILM_NEEDS` (ffmpeg, ttyd), checked at start and in `doctor`

## Connected to

- **joins:** [[session]], [[human-hands]], [[flow]] (trace screenshots), [[settings]] (`AUTOBROWSE_FILM`, `AUTOBROWSE_FILM_SIZE`)
- **looks-like-but-is-not:** the recorder (`src/recorder/`, a person's session for compiling); OBS calls (`src/calls/`)

## If you change this

- **Hits:** `src/browser/session.ts`, `src/browser/flow.ts`, `src/explore/server.ts` (hands log), `src/app/cli-film.ts`, `src/app/cli-reach.ts` (doctor); wren's studio reads the take (wren designs 2026-10-24-filmed-takes).
- **Does not hit:** flows, walks, the agent.

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse film <tape> --out <dir>` | films a tape |
| `AUTOBROWSE_FILM=<dir>` on any command | films its browsers |
| `autobrowse doctor` | the `film` row |

## See

- Source: `src/browser/film.ts`, `src/film/`
- Tests: `test/film.test.ts`, `test/film-tape.test.ts`
