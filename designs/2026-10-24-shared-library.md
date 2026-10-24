# Shared library: flows and traces, on by default

2026-10-24. William: "have it default on with an opt out. i want to collect traces. if we can have a PII protection system that'd be good." Bead wa-gwyx, epic wa-t6yh.

## Goal

Every autobrowse install sends its compiled flows and its run traces to Wren, with personal data removed on the machine first. Good flows go into a public registry that every install can pull from. The traces teach heal, repair and the model.

## Target state

1. **Share is on by default.** The first run prints one notice: what is sent, what is removed, how to stop. The README says the same.
   Stop it with `autobrowse share off`, `AUTOBROWSE_SHARE=off` or `DO_NOT_TRACK=1`. `autobrowse share status` shows the state and the queue.
2. **Never shared, whatever the switch:** personal profiles (`network.personal`), secret flows (no trace is made), the person's own browser (`session.shared`), and flows that `autobrowse share exclude <site>` names.
3. **Scrub on the machine, before the queue.** `scrubTrace(zip, known)` writes a new zip. The raw zip stays on the machine as now. Steps, in order:
   - Drop what holds pixels or bodies: `screencast/*`, screenshots, network response bodies, `trace.stacks`.
   - Network: keep method, host, path and status. Drop headers, cookies, post data, query values.
   - Known values: every value the run typed (`fill`, `type`, `place` secrets as resolved), the profile and wallet fields, the account's email and handle. Each is replaced by its kind (`<email>`, `<typed:3>`) wherever it shows: snapshot text, attributes, URLs, action params.
   - Inputs: each `value` of an input, textarea, select and contenteditable in DOM snapshots becomes `<input>`.
   - Patterns: `redactText` (tokens, cards), plus emails, phone numbers, IPs and long numeric ids.
   - Check: the scrubbed zip is searched for each known value again. One hit fails the scrub, and nothing is queued.
4. **Queue and send.** Scrubbed zips and flow packs (`outline.json`, `proof.json`, the compiled `.ts`) go to `~/.config/autobrowse/share/queue/`. A send step uploads them to Wren's ingest. Ingest gives a presigned PUT into a private `inbox/` prefix, with a size cap and a rate cap per install id. The install id is random, made on the first run. It carries no name or email.
5. **Second pass at Wren, before use.** A job runs Presidio (Microsoft, MIT, self-hosted) over the snapshot text in each inbox zip. A hit is masked, and the zip moves to `kept/`. Nothing in `inbox/` is read by any model or person.
6. **Registry.** For each flow pack, the gate runs: static check (compiles, no literal values, gitleaks), a clean replay that matches `proof.json`, a send gate before each irreversible step, then William's yes. Passed flows become a pull request to the public `wrenautomation/autobrowse-flows` repo by our job, not by the user's GitHub. `autobrowse workflows add <name>` pulls from it. A nightly re-proof marks a flow broken; heal fixes it as a new PR.

## Build order

1. `scrubTrace` + its tests, local only. No upload. Built: `src/shots/scrub.ts`, `redactPii` in `src/recorder/redact.ts`.
2. Switch, notice, exclude list, queue, `share status`. The runner keeps the trace of every run, not only failures and watched runs as now (`flow.ts` stops tracing without a path on success). It collects `known` in the run (each `fill`/`type` value, each `place` value as resolved, the profile's fields) and scrubs right after `tracing.stop`, in the same process. `known` is never written to disk.
3. Ingest (presign) + inbox bucket prefix + Presidio job.
4. Send step on the desk timer and after each CLI run.
5. Registry repo, gate and `workflows add`.

## Decision log

- 10-24: Default on, opt out. William's call. My earlier advice was opt-in; he overrode it. The first-run notice and README line make it disclosed, not silent. `DO_NOT_TRACK` is honored because users expect it.
- 10-24: Traces, not only flow packs. William's call. Scrubbed on the machine so raw personal data never leaves it.
- 10-24: Screen frames and screenshots are dropped, not blurred. They are about 90% of a trace's size and hold the most personal data. OCR redaction (Presidio image redactor) misses text in images often enough to leak. Cost: heal and repair learn from DOM snapshots and actions only. Ideal would be redacted frames; revisit if snapshot-only traces prove too thin.
- 10-24: Known-value scrub is the main defense, patterns and Presidio are backups. We know exactly what the run typed and what the profile holds, so an exact match catches what a detector would guess at.
- 10-24: Presidio runs at Wren, not on the machine. It needs Python and models; an npm CLI cannot ask every user for Docker. It is a second pass on already-scrubbed data.
- 10-24: Registry PRs come from our job, not the user's GitHub. Users need no GitHub account, and the gate runs before any PR exists.
- 10-24: Trace format 9 (Playwright 1.63): `trace.trace` + `trace.network` NDJSON, `resources/<sha1>`, `screencast/*.jpeg`, `trace.stacks`. Snapshots are inline nested arrays `[tag, attrs, ...children]` with back references `[[n, m]]`; input values sit in `value` and `__playwright_value_`. The scrubber names the version; a format change shows as a failed scrub test.
- 10-24: Known values under 5 characters, or digit-only under 7, are not replaced or checked. On a real failed Workday trace a typed year matched every date and frame id. Typed values are masked by place (action params, input values) whatever their length.
- 10-24: Real check, one failed Workday apply trace (a resume, the hardest case): 8.1 MB, 576 files → 0.5 MB, 2 files, 1 s. Every typed value gone in all forms; no address, home folder or query value left. Images and response bodies go; Workday had no CSS kept, so its snapshots render unstyled.
- 10-24: SVG geometry attributes (`d`, `points`, `viewBox`, `transform`) skip the text pass. They hold only numbers, and the phone pattern read them as phone numbers.
