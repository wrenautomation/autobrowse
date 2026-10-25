# Secrets out of traces (2026-10-24)

## Goal

A trace keeps the whole run for debugging. It never keeps a password, a sign-in code, a card number or a session cookie. This applies to new traces and to every trace already written, on this disk and in the backup. Nothing is deleted.

## Facts

- Hands types one key per call (`keyboardType`). A password is in the trace one character at a time, with its slips.
- Playwright's snapshotter writes every input's live value (`__playwright_value_`). Password fields are not masked. Each snapshot after a key holds a longer prefix.
- Login POST bodies (`resources/<sha1>`) hold the password, form-encoded. `.network` rows hold `cookie` and `set-cookie` values.
- The film hands log (`film.ts`) wrote each typed key.
- 10-24: 888 zips on this disk (plus `TRACE_DIRS`), 4,557 in `TRACES_TO` (41 GB, Glacier IR, no versioning).

## Design

- `src/browser/secrets.ts`: a set of secrets held in process memory only. Read sites hold the value: `passwordOf`, a login's code, explore `place` (session secrets, bank codes, card number and CVC) and the recorder's secret fields. Values shorter than 4 are not held.
- `src/browser/trace-secrets.ts` `scrubSecrets`. It works on one trace in memory:
  1. Secret fields (`type=password`, `autocomplete` current-password, new-password, one-time-code, cc-number, cc-csc, cc-exp) lose their values in every snapshot. Each value found becomes a secret too.
  2. Keyboard runs are rebuilt: keys in order, Backspace takes one back, `waitForTimeout` and `mouseMove` do not end a run, Enter and Tab do. When a run's text holds a secret, every key in the run is masked, slips too. Its log lines are masked too.
  3. Every string in events and network rows has each secret masked: raw, URL-encoded, form-encoded, JSON- and HTML-escaped. Text bodies get the same. Images and frames stay as they are (a field shows dots).
  4. `cookie`, `set-cookie`, `authorization`, `proxy-authorization` headers and cookie rows lose their values.
  5. Each secret is searched for again and the count is reported. A hit never drops a trace.
- `scrubSecretsFile`: a temp file, then a rename. The mtime is kept, so the sweep ages the trace as before. An unchanged trace is not written again. The scrub is idempotent.
- New traces: `flow.ts` and `recorder/browser.ts` scrub right after `tracing.stop`. The hands log writes `•` for each key of a held secret.
- Old traces: `autobrowse traces scrub [--backup]`. It scrubs this disk in place, then pushes, so a changed trace replaces its kept copy under the same key. `--backup` fetches each trace that is only in the backup, scrubs it and puts it back under its key. `traces-scrubbed.tsv` records each trace done, so a stopped run resumes.

## Decision log

- 2026-10-24: scrub at save, not `tracing.startChunk`/`stopChunk` around the typing. Later snapshots keep the field value anyway, and chunks split one run into several zips.
- 2026-10-24: not the share scrubber (`share/scrub.ts`). It drops frames, bodies and typed text, and masks PII. Local traces stay whole. Only `forms`, `escapeRe` and `Json` are shared.
- 2026-10-24: the migration matches the secrets the traces hold (secret fields) and the ones this process holds. It does not read every credential from the store: that floods the audit log and the KMS decrypt alert. Gap: a password typed into a field that is no password field, in an old trace, stays. New traces hold it at read time.
- 2026-10-24: cookies and auth headers masked: they are live session secrets. Debugging rarely needs their values.
- 2026-10-24: no raw CDP for automation. Patchright already removes the `Runtime.enable` leak. CDP sessions are used where needed (screencast, input). Raw CDP would lose auto-wait and locators.
- 2026-10-24: backup cost: Glacier IR retrieval $0.03/GB (41 GB ≈ $1.23), egress inside the 100 GB/month free tier, early-overwrite charge ≤ 90 days of storage (≈ $0.50).
