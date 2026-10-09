# Network capture

Living doc. Started 2026-10-06. William: "Autobrowse network tools tracking site html etc (more signal to agents)". Then: "go on everything".

## Answer first

- Off by default since 2026-10-09. `AUTOBROWSE_NETWORK=1` (or true, on) turns it on for a process: flows log calls and save HTML on failure, and explore's `network` and `html` work. Off, none of it runs and both commands say how to turn it on. William: it "might be taking too many tokens"; agents read the failure logs and saved pages.

- Each browser session keeps a log of its page calls: XHR and fetch, plus document loads. A row holds the method, the URL, the status, the request body and the JSON or text response. HTML is saved on a failure and on explore's `html` command.
- Explore gets two commands. `network` lists the calls, shows one, or diffs them against the site's last session. `html` saves the page and diffs it against the last save of the same URL shape.
- Stored like screenshots. An explore session writes `recordings/.explore-<site>/network-<stamp>.jsonl` and `html/<stamp>-<n>.html`, and the shots shipper sends both to the private S3 bucket. A failed flow writes `<stamp>.network.jsonl` and `<stamp>.html` beside its PNG.
- Uses:
  - Find the JSON API behind a page and call it instead of reading the DOM.
  - Diff over time: a records op that drops rows can check whether the call behind it changed.
  - Evidence when a flow breaks.
- $0. Local files and the bucket that already exists.

## Guards

- Redaction happens before anything is written:
  - Headers: `authorization`, `cookie`, `set-cookie`, `proxy-authorization`, and any header whose name says token, secret, key, auth, session, csrf or signature are dropped.
  - Query values and JSON keys with those names, or with the recorder's secret-field names (password, code, card...), become `<redacted>`.
  - Every remaining string goes through `redactText` (token shapes, card numbers).
- Personal profiles keep calls, no content. On `x`, `linkedin` and `google` (no `@label`), a row is the method, the URL without its query, and the status. No bodies and no HTML. `NETWORK_PERSONAL` adds more.
- A flow marked `secret` writes no network or HTML file, same as its screenshot.
- Caps:
  - A body is kept up to 256 KB. Binary types, images, fonts, CSS and scripts keep no body.
  - An explore session keeps up to 2,000 rows and 32 MB of bodies. A flow keeps 300 rows and 8 MB. The oldest rows go first; past the body cap a new row keeps no body.
  - The HTML of one page is kept up to 5 MB.
- The shipper still skips any file over 20 MB.

## Shape

`src/browser/network.ts`:

- `NetLog.of(context, { site, maxRows, maxBodyBytes })` attaches once per context (a parked browser serves many runs) and listens to the context's `response` events, so every tab and popup counts.
- `rows()` returns the calls. `row(id)` returns one call with its body. `jsonl()` writes them out.
- `shapes(rows)` reduces calls to `method host/path` (ids as `*`, the walks' `urlShape`) with the JSON key paths of each response, three levels deep.
- `diffShapes(before, after)` lists calls added and gone, plus the keys added and gone on calls both sides share.

Explore:

- `{ cmd: "network" }`: the last 40 calls, one line each: id, method, status, shape, size, top keys.
  - `filter` matches the URL. `id` shows one call with its body (capped like `text`).
  - `diff: true` compares against the newest `network-*.jsonl` from an earlier session of this site.
- `{ cmd: "html" }`: saves the page and returns the path and size. `diff: true` adds the lines added and removed against the last save of the same URL shape.

## Decision log

- 2026-10-09: Off by default (`networkOn` in `src/browser/network.ts`). William suspected the token cost, and the skill told agents to reach for `network`. The code stays; one env var brings it back.

- 2026-10-06: William approved it as part of "go on everything", relayed by the wren UI session. Built without a second yes.
- 2026-10-06: The capture listens on the browser context, not the page, so OAuth popups and new tabs are in the log.
- 2026-10-06: Personal profiles are a fixed list, since accounts carry no personal flag in code. The list errs toward keeping less.
- 2026-10-06: HTML is saved on demand and on failure, not on every load. Every load would write megabytes per session that nobody reads.
- 2026-10-06: The shipper stores `.html` as `text/plain`, so the bucket never serves a saved page as a page.
- 2026-10-06: A failed flow writes its network log next to the PNG, not a trace zip. A trace holds field values unredacted. The log is redacted and is plain text a model can read.
