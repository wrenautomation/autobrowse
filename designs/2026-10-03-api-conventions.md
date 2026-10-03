# HTTP API conventions (2026-10-03)

William: make the autobrowse API well designed: REST conventions,
pagination, limits, filters (with indexes behind them), rate limits, input
validation, clear error codes.

## Shape

- One helper module, `src/ui/http.ts`. Every handler reads input and refuses
  through it, so the rules live in one place.
- Errors: `{ error, code, issues? }`. `error` is the sentence a person reads
  (it starts with the first bad field: `limit: …`).
  `code` is what a program branches on. `issues` lists every bad field as
  `{ path, message }`.

  | Status | code | When |
  |---|---|---|
  | 400 | `invalid_body`, `invalid_query`, `invalid_path`, `invalid_json` | input fails its schema or does not parse |
  | 401 | `unauthorized` | no bearer, or a wrong one |
  | 403 | `forbidden` | the key's scope or the origin |
  | 404 | `not_found` | no such thing, unknown action, unknown route |
  | 409 | `conflict` | not now: no open gate, a step still blocked, a session action that cannot run in its state |
  | 413 | `payload_too_large` | body over 1 MB |
  | 415 | `unsupported_media_type` | a body that does not say JSON |
  | 429 | `rate_limited` | over the caller's minute; `Retry-After` set |
  | 500 | `internal` | a thrown handler; logged, no stack in the answer |
  | 501 | `not_configured` | this worker lacks the part (no model, no browser, no ledger) |
  | 502 | `upstream_error` | the site behind a route failed; `upstreamStatus` kept |

- Bodies: `readJson(c, schema)`. No body reads as `{}`. A body must be
  JSON, parse, then pass the schema.
- Query and path: `readQuery`, `readPath`. A bad site or recording name is
  refused before any lookup.
- Lists: newest first, bare arrays. `?limit=` has a default and a max.
  When more rows follow, `Link: <same query&before=<cursor>>; rel="next"`.
  - `/api/runs`: `limit` (100, max 500), `before`, `status` (comma list),
    `workflow`.
  - `/api/recordings`: `limit`, `before` (`startedAt~name`), `site`.
  - `/api/jobs`: `limit` (max 100), `status`, `kind`.
- Index: the runs registry keeps its rows sorted newest first (capped at
  2000). That sorted list is the index. A page bisects to the cursor, then
  walks forward keeping rows that match `status`/`workflow` until it is
  full. Filtering happens inside the registry, so a filtered page arrives
  full and only matching rows cross the wire. A new sort order would need a
  second sorted list; none is asked for yet.
- Created and accepted: `201` with `Location: /api/agent/<id>` for a new
  session. `202` with `Location: /api/jobs/<id>` for a job, or
  `/api/runs/<workflow>/<key>` for a run.
- Rate limits: fixed one-minute window per caller (agent key name, or the
  operator). Reads (GET, HEAD) 600, writes 120, `/hooks/*` 60 per IP.
  Every answer carries `RateLimit-Limit`, `RateLimit-Remaining`,
  `RateLimit-Reset`. Limits are `LIMITS` in `src/ui/api.ts`; `ApiDeps.limits`
  overrides them (tests).
- Unknown `/api/*` or `/hooks/*` paths answer JSON 404 inside the API app.
  Mounted under the UI server, the SPA fallback would otherwise answer with
  HTML.
- SSE `/api/events` resumes from `Last-Event-ID` as well as `?after=`.

## Decision log

- 2026-10-03: error body stays flat (`error` is a string) with `code` added.
  The SPA and wren's `do.ts` read `body.error` as a string; RFC 9457
  problem+json would break both for no gain.
- 2026-10-03: list bodies stay arrays; the next cursor goes in `Link`
  (GitHub style). An envelope `{ items, next }` would break every reader.
- 2026-10-03: filters run in the registry, over its sorted list. No database
  index: the registry is a Restate object holding at most 2000 rows, so a
  walk is microseconds.
- 2026-10-03: `/api/runs` max limit 500, under the registry's own cap of
  1000, so the one extra row asked for (to know a next page exists) always
  comes back.
- 2026-10-03: `findRow` (paging up to 10 pages for a waiting run) became
  `list({ status: ["waiting"], limit: 1 })`. One call.
- 2026-10-03: `/api/agent` stays singular. Fence rules, the UI, tests, docs
  and the skill all use it; renaming buys nothing.
- 2026-10-03: no automatic 405. An unrouted method answers 404 `not_found`.
- 2026-10-03: 503 for "no model configured" became 501 `not_configured`. It
  is a setup gap, not a passing outage, and a retry will not fix it.
- 2026-10-03: a failed command or action on a live agent session is 409, not
  400 or 404. The input was fine and the session exists; its state refused.
- 2026-10-03: the explore loopback server (`scripts/cmd.sh`) is a command
  socket, not REST. Left as is.
