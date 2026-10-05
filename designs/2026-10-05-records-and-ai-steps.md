# Records and AI steps

Living doc. Started 2026-10-05. William: "letting ai write check and validate code and then if it works just directly plugging that into autobrowse as the deterministic workflow makes sense. it should fit into our existing interfaces facade patterns etc." Then, on the two gaps below: "yeah those two gaps are good to upgrade on."

## Answer first

- **The gaps.** A `read` op takes one element's text (`src/compiler/outline.ts`). A list page (ads, group posts, a directory) needs many rows. And no step can call a model at run time in a way the walk shows.
- **`records` op.** A model writes a small extractor once: JS over the page that returns rows of named fields. Code checks it, and only a checked extractor is kept in the walk. Replays run it with no model.
- **The check.** The code runs on the live page and must return rows, every row must have the declared fields, and required fields must be filled on most rows. It must also find the rows a model read off the page text by eye (2 to 3 samples). A failed check goes back to the model with the reason, up to 3 rounds.
- **Heal on a drop.** At run time, fewer rows than the kept floor (half of what the page gave when written) or required fields left empty means the page changed. With a model at hand, the walk re-writes the extractor on that page, checks it, saves it, and goes on. Without one the run fails, like any broken step.
- **`ai` op.** An explicit model call in a walk: a prompt over earlier reads, the answer kept under a name. It names its model tier: `cheap` (Cohere when keyed, else Claude Code on the subscription, $0) or `smart` (the configured model). Each walk run caps it at 20 calls. Every call goes through the counted, daily-capped `llmFor`.
- **Where it runs.** Walks are the deterministic workflow, so both ops live in `walkOpSchema` through `opSchema`. The TS compiler refuses them for now, since teach mode made walks the browser path.

## The records op

```json
{ "kind": "records", "goal": "ads running now", "as": "ads",
  "fields": [{ "key": "advertiser", "says": "who runs the ad" }, { "key": "link", "says": "the ad's page", "optional": true }],
  "key": "advertiser", "code": "return [...root.querySelectorAll(...)].map(...)",
  "min": 12, "max": 60, "sample": [{ "advertiser": "Acme Staffing", "link": null }] }
```

- `code` is a function body over `root` (the document).
- **Sandbox.** The code never runs in the real page. The page's markup (scripts out, a `<base>` so links resolve) goes into a fresh headless browser that refuses every request, so the code sees the DOM and nothing else: no cookies, no network, no navigation. It has 15s.
- **Feeds.** With `max` set, it reads, scrolls and reads again through `scrollCollect`, one row per `key`, until `max` rows or the feed ends.
- **Store everything.** `walks run` writes every row to `<artifacts>/records/<site>-<walk>-<time>.jsonl`, next to the page's full HTML.

## Writing one

`autobrowse records <site> <name> --url <url> --fields "advertiser:who runs it, text:the ad text, link?:its page" [--key advertiser] [--max 60] [--plan q=staffing]`

1. The flow opens the URL (`{q}` in it is a plan field).
2. **Eye.** The model reads the page text and returns up to 3 rows it can see.
3. **Write.** The model gets a skeleton of the DOM: tags, ids, classes, data and aria attributes, short text, and look-alike siblings folded. It also gets the fields and the eye rows, and returns `code`.
4. **Check** (above). On a fail the reason goes back, up to 3 rounds.
5. The kept walk: one screen that opens the URL and runs the op, then a goal screen. `walks run <site>/<name> --plan q=...` replays it.

**Logged out only for public reads.** Walks open the site's own browser profile, and `facebook` signs in as Wren. So `records` refuses a Meta host (facebook, instagram, threads) under a site that has a login. Public Meta reads use a site key with none (`fb-public`).

## The ai op

```json
{ "kind": "ai", "goal": "which ads hire", "as": "hiring", "prompt": "Of these ads, which offer jobs? {ads}", "model": "cheap", "maxTokens": 400 }
```

- `{name}` is an earlier `read` (text) or `records` (JSON, capped at 20k characters).
- **Cost.** A cheap call on 20k characters is about 5k tokens in and 400 out. On Cohere Command A that is about $0.017 of prepaid credits, so a 20-call run costs about $0.35. Claude Code runs on the subscription for $0, about 2s a call. Either way, a `smart` call follows `LLM_PROVIDER`. Every call counts against `LLM_DAILY_TOKENS`.

## Where to attack

1. ✅ `records` and `ai` ops, sandbox, check, writer, walk runner, heal on drop, `autobrowse records`.
2. ✅ Meta Ad Library logged out (`fb-public/ad-library`), proved live.
3. Facebook public groups, then directories.
4. An explorer `records` command, so an explore run that ends on a list page builds a walk with the op.
5. Compiler render, if a compiled workflow ever needs a list.

## Decision log

- 2026-10-05: The extractor is code, not a declarative selector spec. William asked for AI-written, checked code. It also handles pages a selector list can't (rows split across siblings, dates in attributes).
- 2026-10-05: The model's eye read of the page text is the semantic check. It catches an extractor that runs and returns the wrong rows, which a schema check alone misses. It runs only when code is written, since a replay's page holds new rows.
- 2026-10-05: Heal lives inside the walk runner, not the outline healer, because walks are data: swapping `code` and saving the spec is the whole fix.
- 2026-10-05: Only the CodeGeneratorGraph loop idea was taken (write, run, check, feed the error back). The library wasn't adopted.
- 2026-10-05: The sandbox is the boundary, not a word list. The page's markup is copied into a headless browser that refuses every request, so the code never runs in a signed-in page and has no cookies and no network. A word list would miss computed names.
- 2026-10-05 trial, Ad Library logged out under `fb-public`, Claude Code ($0):
  - "staffing agency": the first round passed, with 30 rows and 27k tokens in. The model anchored on the "Library ID:" text, not FB's generated classes.
  - The replay on "recruiting firm" took 8.7s with no model. It returned 25 rows, with every field filled on 24 or 25 of them.
  - An extractor broken on purpose was re-written on the next run ("dental office", 30 rows) and saved.
