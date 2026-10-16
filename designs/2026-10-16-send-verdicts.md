# Send verdicts: autobrowse knows whether a write went out

2026-10-16. Approved by William: "lets go with your proposal ... just want it to be consistent, like whatever restate does."

## Problem

A desk write (a post, a comment, a DM) can end with no answer: a crash, a lost stream, a replay. Today autobrowse throws prose for that case ("may have gone through", "already went through on an earlier try"). Wren parses the words (`sendFate` in `wren/packages/core/src/maybe-sent.ts`) and runs its own per-platform looks to find out. Two layers guess. A wrong guess posts twice (Reddit, 10-15) or marks a live post failed (TikTok, 10-16).

## Decision

Autobrowse owns the verdict. Every irreversible write answers one of three typed results. Wren maps them and never reads error text.

The model is Restate's own:

| Restate | Send verdicts |
|---|---|
| An idempotency key: one invocation per key, a repeat gets the stored result | The caller's send key: one write per key, a repeat gets the stored verdict |
| `ctx.run` journals a step's result; a replay returns it, never runs it again | The desk journal keeps the submit and its verdict; a rerun never writes again |
| A terminal error means it did not happen and will not be retried | `not_sent` means nothing went out; the caller may send again under a new key |
| Retry with backoff until the step settles | An unclear end runs the verify read with backoff until it settles, then answers |

### The verdict

```ts
type SendVerdict =
  | { verdict: "sent"; id: string | null; url: string | null; at: string; how: "answer" | "verified" }
  | { verdict: "not_sent"; reason: string; how: "refused" | "before_submit" | "verified_absent" }
  | { verdict: "unknown"; reason: string; since: string };
```

- `sent`: the platform answered with the object, or the verify read found it.
- `not_sent`: the platform refused, the failure came before the submit step, or a full verify read found it absent.
- `unknown`: the verify read failed, came back partial, or the route has none. Never a guess.

The verdict is the call's result, not an error. A request that is wrong (bad body, no route, no token) stays a `SiteError` as today: nothing was attempted.

### Keys

- The caller passes a send key on every irreversible call (wren: the `send_attempts` ref). It rides as the Restate `idempotency-key` header on the desk call, so Restate itself dedupes the invocation, and as the desk journal's key.
- The desk journal keeps, per key: started-at, submitted (yes or no), the words matcher, the verdict.
- A call with a key that has a final verdict (`sent` or `not_sent`) answers it at once and writes nothing.
- A call with a key whose verdict is `unknown` runs only the verify read again, never the write.
- "Send again" from a person makes a new key. That is the only way a second write happens.

### Verify reads

- Each irreversible route declares `verify`: a read of the account's own recent objects (its posts, its comments on that thread, its DMs to that person) and a matcher (words + time since the send started).
- The reads that exist move here from wren: Reddit thread comments, X replies (`Content.findReply`), Meta private replies and Page conversations, Instagram post comments, LinkedIn DMs and comments, TikTok `/v2/video/list/`, YouTube, the Facebook Page feed. Matching is one shared helper (normalized words, time window); no per-site copies.
- `absent` needs a full read: a list cut at its limit, or one ranked rather than by time, answers `unknown`.
- Backoff: up to 3 reads over about 10 minutes, since platform lists lag. Then answer.

### Wren

- Desk calls send the key and read `SendVerdict`. `sendFate` and its text matching are deleted.
- `send_attempts`: `sent` → sent with id and url; `not_sent` → may send again; `unknown` → unsure, shown in To approve "May have gone out" as today.
- Mark posted / Send again stay. Add "Not sent, drop" for an unsure item a person checked.
- Own-channel publishes (ContentScheduler) use the same path: `sent` → markPublished, `not_sent` → back to approved for the next slot, `unknown` → unsure, never failed.
- Wren's own look code (`packages/outreach/src/restate/maybe-sent.ts`, `packages/core/src/content/page-inbox.ts` matching) goes once autobrowse answers verdicts. The `send_attempts` ledger and To approve stay.

## Not changed

- A write's leg (API or browser) and its grants.
- `dlq kill` on a desk send is still wrong until wren reads verdicts everywhere; after that, a killed call's key reads back its verdict.

## Done when

- A desk write killed mid-call, rerun with its key, answers the verdict without a second write (test per leg: API and browser).
- Every irreversible route has `verify` or is listed as "unknown only" with a reason.
- Wren has no code that reads autobrowse error words.
- The 10-15 Reddit case and the 10-16 TikTok case each have a test that fails on the old code.
