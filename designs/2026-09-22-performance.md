# Performance and memory sweep (2026-09-22)

Trigger: William, "make sure code is algorithmically performant and memory
wise (data IO is efficient, pointers are efficient, etc.)". One pass over
every path that runs per request, per step, per poll or per event, and
every store that grows.

## What changed (1d05e9d, this commit)

- **Credentials.** `keychainKey()` spawned `security` on every
  `credentialsFor` (28 call sites; a `needs` page built two stores):
  read once per process, cleared by `trustKeychainKey`. `fileCredentials`
  read, decrypted and zod-parsed the whole file on every `get` and
  `list`; a `profileOf` scan is `list` + a `get` per name. Now one parse
  per file version (`stat` per call: mtime + size), a `put` or another
  process's write re-reads. No caller mutates what it gets back.
- **Runs registry.** One Restate state key held every run ever, read and
  rewritten whole on every event. `trimRows` caps it at 2,000: live runs
  always stay, the oldest settled go. `pageOf` still sorts, over ≤ 2,000.
- **Event bus.** `ring.shift()` per event past capacity and a filter per
  `recent(after)` → a fixed ring with a head, bisected by seq.
- **Gmail polling.** `recent` fetched every body in series on each 3 s
  poll; bodies are immutable, so they are kept by inbox + id (200) and
  fetched in parallel. A poll with nothing new is one list call.
- **Page text.** `fp.text()`, `looksLikeWall`, explore `text` and
  `fp.html()` pulled the whole `innerText` / `content()` over CDP and
  sliced after (20 KB kept of pages that run to MB). `bodyText` and
  `pageHtml` slice inside the page; only the kept part crosses.
- **Ledgers.** Audit and spend `recent(n)` read and split the whole
  append-only file; `spentToday` asks for 1,000 rows at every gate.
  `tailLines` reads 64 KB blocks from the end until n+1 line breaks.
- **Agent sessions.** A closed session kept its `Explorer` (pages, journal,
  queue) alive in the map; it is dropped on close and when the browser
  goes. The map itself is bounded by what the person starts.
- **Needs.** `phoneStatus` (sqlite3 + osascript) and the desktop probe
  ran once per row that asked; once per context now.
- `parseAria` copied and reversed the stack per property line; the Runs
  page re-sorted on every event (`placeRow`, 81604a7).

## Read and left alone (why)

- `digest` re-indents child lines at each container: O(lines × depth)
  string copies, a few ms on a 5k-node tree, once per agent step. A
  depth-tagged piece list would remove it; not worth the churn to a
  tested output.
- Compiler passes scan `fields`/`secrets` per action (≤ 20 entries);
  compile is one-off.
- Jobs keep 100 finished and sort per `list`; sessions keep steps (text,
  screenshots are files); the agent prompt carries the last 6 steps.
- SSM pulls by path (one call), puts are per name by design.
- Budget ledger, `.env` sink, identities, needs-done: tiny files, sync,
  atomic rename; read per call is right (another process may write).
- `fetch` keeps connections (undici); no client builds a connection per
  call.

## Where to attack (ranked)

1. Restate state for the registry is still one key: 2,000 rows ≈ 400 KB
   read and written per event. A key per row with `ctx.stateKeys()` for
   the list would make writes O(1); the list then costs N gets. Measure
   before changing: at today's rate (tens of runs a day) the cap holds
   for months.
2. `digest` depth tagging (above) if a page ever makes a step slow.
3. `listRecordingSummaries` reads one summary per recording; a single
   index file would be one read, invalidated per save.
4. ✅ (2026-09-22) The registry keeps its list newest first: `record` is a
   `placeRow` (one pass), `list` bisects to the cursor and slices
   (`pageOfOrdered`), `trimRows` walks once. A map stored before this
   reads once more (`orderedRows`) and is written back as a list.
