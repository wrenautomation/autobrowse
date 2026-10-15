# A busy profile queues the call

2026-10-15, bead wa-z8q. At 17:00 UTC a scheduled TikTok post failed for good: `profile
google@wren is open in pid 11913 (explore:9092); may have gone through`. The desk refused at
profile open, before Chrome launched. Nothing was posted. The same lock closed tab watchers and
failed Reddit reads.

## What happens now

- **Wait, don't fail.** `assertProfileFree` throws `ProfileBusy`. `waitForProfile`
  (`src/browser/profile-wait.ts`) wraps every `sites`/`desk` `call`, `arm` and `setup`: a busy
  try is journaled as an answer (not a throw, so a write's one try is not spent), then a durable
  `ctx.sleep` (15 s, 30 s, then 60 s), then a new step `<name> (try n)`. It runs once when the
  profile frees.
- **Bound.** Past 5 min it goes back as `TerminalError("not sent: profile X is busy (owner);
  waited N min for it, try again", 503)`. Callers read 503 + `not sent:` as "try next tick".
- **Exact words.** A failed write says whether it left. `markSubmitted()` flags the call when a
  flow's irreversible act starts, or when the API leg is about to send. Not flagged: `not sent:
  <why>`. Flagged: `<why>; may have gone through`. A refusal under 500 stays as it is.
- **Lease.** An explore session closes after 10 min with no command, journal kept. A write (not
  a read) takes the profile from a session idle 3 min, not held, not driven by a person: `close`
  with `keep` and a `why`, logged `profile taken from idle explore`. A session being driven
  keeps it; the write waits.
- **Watchers.** On a busy profile the watch is `paused`, looks again each minute, no doubling,
  and opens when the profile frees. Never `watch closed` for it.
- **Caps.** A busy try reached no site, so its meter is given back.

## Decisions

- One wrapper in the service, not per site: every desk call gets it.
- Journal the busy try as a value. Throwing would hit `WRITE_RETRY`'s one attempt.
- Take only from explore/agent sessions. Desk, CLI and teach sessions are never closed.
- `do` and `browser` services unchanged: box-only, and `browser` already retries.

## Wren

wren reads 503 + `not sent:` (`browserBusy`) and keeps the draft approved and scheduled,
showing "Waiting for the browser". Untagged legacy messages still read as "may have gone through".
