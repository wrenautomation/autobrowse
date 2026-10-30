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

## Verify per route

One row per irreversible route (`src/sites/*.ts`). A read lists the sending account's own recent objects; `settle` matches them (`src/sites/verdict.ts`). "Unknown only" routes carry `verify: { none }`. Notes: Reddit ids are fullnames (`t1_`, `t3_`). A row that is not a match for this send (other parent, other person) keeps `mine: false`, so the last row still shows how far back the list reaches. `read` gets no account name, so each read finds it through `get` (`/api/v1/me`, `/v2/userinfo`, `/me`).

| Site | Route | Verify read | Why |
|---|---|---|---|
| linkedin | `POST /rest/posts` | `GET /rest/posts` by author, newest 10 | Matches the commentary. Cut at a count, so absent only past the send in time. |
| linkedin | `POST /rest/socialActions/{urn}/comments` | `GET /rest/socialActions/{urn}/comments`, 100 | A Page matches by actor. A member matches by `/v2/userinfo` name, since the browser read names members by profile link. Parent must match. Ranked, never complete. |
| linkedin | `POST /in/{vanity}/connect` | `GET /in/{vanity}/relationship` | A state: pending or connected is found, none is absent. |
| linkedin | `POST /in/{vanity}/withdraw` | `GET /in/{vanity}/relationship` | A state: none is found, pending is absent. |
| linkedin | `POST /in/{vanity}/message` | `GET /messaging`, 40 | Preview of the last message only; ours starts `You:`. No time, ranked, never complete: found or unclear. |
| youtube | `POST /upload/youtube/v3/videos` | `GET /youtube/v3/playlistItems` on the uploads playlist | Matches the title. Lags, so absent is unclear. |
| youtube | `DELETE /youtube/v3/videos` | unknown only | A delete is idempotent. |
| youtube | `POST /youtube/v3/commentThreads` | `GET /youtube/v3/commentThreads`, order time | Matches our channel and words. Complete when no next page. |
| youtube | `POST /youtube/v3/comments` | `GET /youtube/v3/comments` by parent | Matches our channel and words. Oldest first, so ranked. |
| youtube | `POST /studio/communityPosts` | unknown only | No read lists community posts. The Data API has none. |
| youtube | `POST /studio/thumbnail` | unknown only | A repeat sets the same image. |
| instagram | `POST /{igUserId}/media_publish` | `GET /containers/{containerId}` (new) | A state: PUBLISHED is found, ERROR or EXPIRED is absent, else unclear. |
| instagram | `POST /web/posts` | `GET /me`, then `GET /{id}/media`, 25 | Matches the caption. Lags (a video lists once processed). |
| instagram | `POST /{commentId}/replies` | `GET /me`, then `GET /{commentId}/replies` (new) | Matches our username and words. Ranked. |
| instagram | `POST /web/p/{shortcode}/comments` | `GET /web/p/{shortcode}/comments`, 100 | The page marks our comments (`mine`). Complete only when `more` is false and the viewer is known. |
| instagram | `POST /web/profile/name` | unknown only | A repeat sets the same name. |
| threads | `POST /{userId}/threads_publish` | `GET /containers/{containerId}` | A state: PUBLISHED is found, ERROR or EXPIRED is absent, else unclear. |
| tiktok | `POST /v2/post/publish/video/init/` | `POST /v2/video/list/` (reads), 20 | Matches the title; no title is unclear. Lags: public and processed videos only, so absent is unclear. |
| tiktok | `POST /web/posts` | `POST /v2/video/list/` (reads), 20 | Matches the caption. Lags like the API publish. |
| tiktok | `POST /web/videos/{videoId}/comments/{commentId}/replies` | `GET /web/videos/{videoId}/comments`, 100 | Our reply has a parent and is marked `creator` or carries our name. Replies load by click, so never complete. |
| tiktok | `POST /web/profile/name` | unknown only | A repeat sets the same name. |
| outlook | `POST /me/sendMail` | `GET /me`, then `GET /me/messages` newest 25 | Matches subject, from us, to the first recipient. Not saved to Sent is unclear. |
| outlook | `POST /me/messages/{id}/reply` | `GET /me/messages/{id}`, then `GET /me/messages` | Matches the preview in the same conversation, from us. |
| outlook | `POST /me/events` | unknown only | The events list orders by start time, so a new event cannot be told from an old one. |
| gmail | `POST /gmail/v1/users/me/messages/send` | `GET /gmail/v1/users/me/messages` (`in:sent`, 10), then each message's metadata | Matches the subject and every To address in the raw message. |
| meta | `POST /{pageId}/feed` | `GET /{pageId}/posts`, 25 | Matches the message. A scheduled or unpublished post never proves absent. |
| meta | `POST /{pageId}/photos` | `GET /{pageId}/posts`, 25 | Matches the message; no message is unclear. Unpublished never proves absent. |
| meta | `POST /{pageId}/videos` | `GET /{pageId}/posts`, 25 | Matches the description or title. Lags (lists once processed). |
| meta | `POST /{pageId}/photo_stories` | unknown only | A story is not in the Page's posts, and no route lists stories. |
| meta | `POST /{pageId}/video_stories` | unknown only | Same as photo stories. |
| meta | `POST /{igUserId}/media_publish` | `GET /{objectId}` (`status_code`) | A state: PUBLISHED is found, ERROR or EXPIRED is absent, else unclear. |
| meta | `POST /{commentId}/replies` | unknown only | Graph names a replier by username, and the input holds no account. |
| meta | `POST /{commentId}/comments` | `GET /{commentId}/comments`, 100 | Matches the Page as author and the words. Ranked. |
| meta | `POST /{pageId}/messages` | `GET /{pageId}/conversations`, Messenger and Instagram | To a person: newest, complete when no paging. A private reply (comment id) has no person, so ranked and never absent. |
| x | `POST /2/tweets` | Post: `GET /2/users/{id}/tweets`, 10. Reply: `GET /2/tweets/search/recent`, `conversation_id` | Words compare without links (`t.co`). A post of media alone is unclear. A reply search lags, so absent is unclear. |
| x | `DELETE /2/tweets/{id}` | unknown only | A delete is idempotent. |
| x | `POST /1.1/account/update_profile.json` | unknown only | A repeat sets the same name. |
| reddit | `POST /api/submit` | `GET /api/v1/me`, then `GET /user/{name}/submitted`, 25 | Matches the title in that subreddit. |
| reddit | `POST /api/comment` | `GET /api/v1/me`, then `GET /user/{name}/comments`, 25 | Matches the words under that parent. Another parent is not a match. A cut list that does not reach the send is unclear. |
| reddit | `POST /api/compose` | `GET /message/sent`, 25 | Matches the words to that person. |
| reddit | `POST /api/subscribe` | unknown only | A join or leave is idempotent. |
| reddit | `POST /web/profile/name` | unknown only | A repeat sets the same name. |
| loom | `DELETE /videos/{id}` | unknown only | A delete is idempotent. |
| npm | `POST /orgs` | unknown only | No read lists the orgs the account made. A repeat is refused, which is harmless. |
| npm | `POST /packages/{package}/trust` | unknown only | No read shows a trusted publisher. A repeat is refused, which is harmless. |
| discord | `DELETE /channels/{channel}` | unknown only | A delete is idempotent. |

## Contract (planner, 2026-10-16)

The seam both repos build to. Types: `src/sites/verdict.ts`.

- `sites/call` and `desk/call` take `sendKey` (1 to 200 chars). Any non-GET call with a key answers a `SendVerdict` as its result. Without a key a call answers as today (the CLI, older callers).
- The caller also sets the Restate idempotency key to the send key, so two live invocations with one key are one.
- A keyed `sent` with `how: "answer"` carries `output`: the official answer an unkeyed call gives. `id` and `url` come from the route's `sentAs`.
- Before the submit step, a `SiteError` under 500 stays a thrown `SiteError` (a bad request, no route, no leg, a cap's 429). Anything else before the submit step is `not_sent` `before_submit`.
- After the submit step, a platform's 4xx (not 408) is `not_sent` `refused` with its `status`. Anything else runs the verify read.
- The desk journal (`src/sites/send-journal.ts`) keeps one file per key: site, method, path, account, input, started-at, submitted, verdict. `markSubmitted` writes `submitted` to the file before the act.
- A key with a final verdict answers it and writes nothing. A key that is submitted with no verdict, or `unknown`, runs only the verify read. A key started but not submitted, with no live call in this process, is `not_sent` `before_submit`: the process that ran it died before the act.
- Verify: up to 3 reads, at 30 s, 3 min and 10 min after the end (`ctx.sleep` between, each read one `ctx.run`). Found is `sent` `verified`. Absent on a full read is `not_sent` `verified_absent`. Else `unknown`. A route with `verify: { none }` is `unknown` with its reason at once.
- `sites/verdict {sendKey}` answers the journal's verdict without the call: for a call that was killed, or to check an `unknown` again (it runs the verify reads again). No record is `not_sent` `before_submit`. A live call is `unknown` "still running".
- Each verify read is a read through the same facade as the sending account (`VerifyGet`: a GET, or a POST route that only reads), so it takes caps and pace like any read.

## Decision log

- 2026-10-16: contract above. `output` added to `sent` so callers keep their answer parsers. `sites/verdict` added because Restate gives a killed invocation's failure back to any repeat of its idempotency key.
- 2026-10-16 (A1 build): the journal lives in `<artifactsDir>/sends/`, one file per key (`sendJournalFor`, `src/app/services.ts`), for both `sites` (box) and `desk` (Mac). `CallTry.onSubmit` is the hook `markSubmitted` calls once, before the act. A hook that throws stops the act.
- 2026-10-16 (A1 build): `SiteFacade.sendSpec(site, method, path)` is optional, so a fake facade needs no change. A route or facade without it reads as "nothing declared": an unclear end is `unknown` "this route has no verify read". Under a keyed call `currentCall()` is `send <key>`, so the API leg's `started` guard and the browser leg's `done` guard span the invocations of one key.
- 2026-10-16 (A1 build): verify pauses are 30 s, 2 min 30 s, 7 min (`VERIFY_PAUSES_MS`), so the reads fall at about 30 s, 3 min and 10 min after the end. The service takes `verifyPausesMs` so a test keeps them short.
- 2026-10-16 (A1 build): a `verdict` call, and a rerun of a key that was submitted with no verdict or `unknown`, read once at once (the end was earlier), then wait the later pauses. A fresh failure waits the first pause.
- 2026-10-16 (A1 build): "refused" is a platform `HttpError` 4xx after the submit step, except 408. A 429 is a refusal too. A `SiteError` 501 (no flow recorded) before the submit step stays a terminal 501, worded `not sent: …` as for an unkeyed call; nothing was attempted, so the journal keeps no record.
- 2026-10-16 (A1 build): a profile wait that gives up (503) is `not_sent` `before_submit` under a key, and leaves no record. The next call under the key starts clean.
- 2026-10-16 (A1 build): a verify read on another site passes no account (the account named for the send belongs to the sending site). A read on the same site passes the send's account.
- 2026-10-16 (A1 build): a journal file that does not parse reads as submitted with `unknown` "the journal record is unreadable". A rerun then verifies and never writes.
- 2026-10-16 (wa-8q7.3, wren gaps): wren reads no site for its own words. Its direct writes (a client's connected account, the direct Reddit API) answer the same `SendVerdict` from a wren send journal (`send_journal`, migration 0288): one record per write key, written before the act; no verify read, so an unclear end is `unknown`. One route rule (`packages/core/src/content/routes.ts`) marks reads, staging writes (containers, uploads) and sends: only a send is keyed or notes the trace, so a publish refused after a container is `not_sent` `refused`. A person's later settle asks in verify-only mode (`verdict {sendKey}`, never a write), so it has no age limit; a pruned key reads `not_sent` and his word stands. A settle that finds the post runs the first comment (its own key) and the posted hook.
- 2026-10-17 (wa-3hf): an irreversible route's leg that answers with no submit step (a flow's `{ found: false, reason }`, a connect with no invite offered) is `not_sent` `before_submit` with the answer's `reason`, never `sent`. A leg that finds the thing already there (the name already set, the org already made, an invite already out) says so with `already(out)` (`browser/attempt.ts`) and stays `sent` how `answer`. Non-irreversible routes (follow, like) are unchanged.
- 2026-10-30: a site can set a least gap between verify reads of one key (`VERIFY_GAP_MS`; LinkedIn 1 h, William). Cause: four `verdict` asks for two LinkedIn comments made 10 post-page reads in 16 min, 3 per ask. With a gap, a call makes at most one read, and a read too soon answers the stored verdict without a read. The journal keeps `readAt`. Rejected: fewer pauses for LinkedIn only (repeated asks still burst); a cap on the caller (each caller would need it).
