# Signed-in reads and captchas for research (2026-10-28)

William, 10-28: "captchas should never be a blocker", "use signed in reads", "use whatever wren
related accounts we have", "which signed in accounts used should be configurable".

## Target

A research read (weaver's `open`) of any page gets its text. Order per URL:

1. A site's own read route, signed in as a configured Wren account. Best text (JSON, whole threads).
2. The plain fetcher (weaver, polite and declared).
3. The fetch ladder: plain with a Chrome UA, impit, render, exit. Render now solves captchas.
4. A gap with every reason. A person (William) is the last rung.

## Decisions

**Captchas in the render rung.** The solver (`browser/captcha`) ran in flows only. The render rung
waited 15 s for a challenge to clear and gave up. Now, after that wait, a page that still shows a
challenge goes through `findCaptcha` and `solveCaptcha` with the flows' hands and eyes
(`captchaFor(settings)`), up to `captchaAttempts` tries, then reads again. A wall left after that is
a block, as before.

**Signed-in reads: options.**

| Option | How | For | Against |
|---|---|---|---|
| A. Site routes per domain | weaver has one reader per site; it calls the site's read route on the desk (`reddit GET /comments/{article}`) with `account` | Clean text, the site's caps and pace hold, no secret leaves the desk | One small reader per site |
| B. Signed-in render | `web GET /fetch` takes `account`; render runs in that account's profile | One door for the long tail | Signed-in app HTML is a JS shell or a feed; the fetch bucket, not the site's caps, counts it |
| C. Cookies out to weaver | Export a profile's cookies; weaver fetches with impit | Fast, no browser | Secrets leave the vault; the IP and TLS do not match the session, a ban risk; a new credential class to audit |
| D. Official APIs | Tokens per site | Stable | Reddit refused our client (09-29); Meta removed the Groups API (2024); LinkedIn serves no page text |

Priorities, in order: no ban risk to an account Wren posts or runs ads with, no secret leaves
autobrowse, the best text, the least new code. **Pick A now.** B waits for a site with no route. C
and D rejected for the reasons in the table. Reddit's route already fetches the `.json` twin from
inside the signed-in page: that is the safe form of "login tokens".

**Which account.** The caller names it, autobrowse holds it. weaver reads `WEAVER_ACCOUNTS`
(`reddit=reddit@alt`), passes `account` on each call, and names no account in code. Reason: the
right account is per caller. wren posts as `reddit@wren`; research reads many pages and should not
risk the posting account, so `reddit@alt` is the suggested read account. A ban on the read account
then costs research, not posting. The accounts, sessions, caps and pace stay in autobrowse
(`creds`, `limits.json`). Rejected: a `reads` purpose in the autobrowse accounts policy. The policy
maps purposes to Google addresses, not to a site's own logins, and it would change every caller's
default.

**Facebook stays signed out.** fb-public's rule holds: never Wren's Meta login, which runs the ads;
Meta bans accounts that scrape. The signed-out post walk (`fb-public GET
/groups/{group}/posts/{post}`) reads public group posts. Change only on William's yes, knowing the
ad-account risk.

**LinkedIn stays on Exa's cache.** A signed-in profile read is the riskiest read for
`linkedin@wren`. No signed-in LinkedIn reader without William's yes.

**The fetcher's user agent stays declared.** The ladder's `plain` and `impersonate` rungs already
send Chrome's user agent, headers and TLS. A Chrome user agent on weaver's own fetcher would save a
desk call per blocked page, but it hides who reads. Revisit if the desk's `fetch` bucket runs out.

## Not done

- B (signed-in render). Build when a site with no route keeps blocking.
- X: `x` has API reads; a reader waits for a run that needs X posts.
- The exit rung needs an `EGRESS_SITES` exit for `fetch@exit`. None is mapped: William's call
  (money).
