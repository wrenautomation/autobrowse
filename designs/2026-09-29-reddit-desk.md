# Reddit posting on the Mac's desk worker

2026-09-29. Status: built. Reads and a refused submit proven, no real post yet.
Open: node needs Full Disk Access before launchd can keep the desk up (William).

## Ask

William: Reddit refused Wren an API client. Post brand content anyway: cool
builds and info posts, zero promotion, the link only in the profile.

## Shape

- `src/sites/reddit.ts` keeps the Data API's shapes (`/api/v1/me`,
  `/user/{u}/submitted`, `/api/info`, `/comments/{id}`, `/r/{sr}/about/rules`,
  `POST /api/submit`, `POST /api/comment`). Every route is a browser leg; wren's
  `channel-reddit` calls it unchanged. An `api` leg joins if a client is granted.
- Flows (`src/browser/flows/reddit.ts`) run on old.reddit.com: stable ids,
  plain forms, and its `.json` reads from inside the signed-in page (the
  modhash never leaves it). Answers match the API's `{json:{errors,data}}`.
- The desk: `src/app/desk.ts` serves the same facade as the Restate service
  `desk` from the Mac, on its own tunnel name in the box's environment. wren's
  `redditFrom` sends Reddit there when no `WREN_REDDIT_*` client is set.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | Browser legs, not a scraper | The API shapes stay; one caller path either way |
| 2 | old.reddit.com | Ids and forms that don't move; new Reddit is shadow DOM |
| 3 | The Mac, not the box | Reddit bot-checks the box's datacenter IP; the proxy is deferred |
| 4 | Separate `desk` service, not a second `sites` deployment | Two deployments of one name would split calls between machines |
| 5 | Caps: 3 posts, 20 comments a day; 20-60 s pace | A person's rate; attempts count, so a failing flow can't loop |
| 6 | Captcha solved in the flow; unsolved → a person | New accounts get reCAPTCHA on submit |
| 7 | Headed sign-in once | Headless login gets "Invalid username or password" (bot check); the session then serves headless |
| 8 | Submit button pinned to `#newlink` | The header search's unlabeled submit input is also named "Submit" (it searched instead) |

## Proven

- `/api/v1/me`, submitted, rules through the facade and over Restate → desk.
- `POST /api/submit` to a missing subreddit → `SUBREDDIT_NOEXIST` on `sr`, nothing posted.
- Not yet: a real post or comment (irreversible; William's first post).
