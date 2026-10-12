# Tab watchers and armed calls

2026-10-12. William: a fake webhook for sites that push nothing ("open a memory efficient
browser window or tab and wait idle until something we want changes"), and replies that run up
to the approval so they go out the moment it comes. The wren side: wren
`designs/2026-10-12-push-everywhere.md`.

## Tab watchers

One tab per watched account, in that account's browser, on a page that marks nothing read:
LinkedIn's feed, X's bookmarks, Facebook's and Instagram's home. The site's own live channel
keeps the tab's title count current (`(3) Feed | LinkedIn`). Every 20 s the watcher reads the
title over CDP; a rise sends the lease's sink.

- Cost: one tab in a browser the desk keeps anyway. Images, media and fonts are aborted, and the
  tab reloads every 3 h so its memory stays flat. The site sees one open tab, never a request
  from us, so no rate limit moves.
- Lease: `desk/watch {site, account, sink: {path, body}, until}`. The caller renews each pass; a
  caller that stops leaves no tab after `until` (at most a day). Leases are kept in
  `watchers.json`, so a desk restart reopens them.
- The browser stays open while watched: `SessionPark.pin`. Flows on the profile still queue
  under its lock and run in its own page beside the tab.
- A broken run closes the browser and the tab with it. The watcher reopens after a minute,
  doubling to 30.
- The sink is a Restate ingress `send` (one way). Rises closer than 30 s send once.
- Every 10 minutes a signed-in tab (still on the spec's page, no sign-in title) also sends
  `kind: "alive"`. The caller may poll less while it hears them; a signed-out tab goes quiet.
- A title without a count is shown in `desk/watches` (`title`): the spec went stale, or the
  profile is signed out.

## Armed calls

A browser leg's flow may define `prepare(fp, input)`: everything `run` does before the first
irreversible step, nothing typed. `sites/arm` (or `desk/arm`) runs it in a new tab and answers
`{armed: id, until}`. The next call on the same path and target (its input minus typed words:
`text`, `message`, `body`, `note`, `comment`) on the same browser runs the whole flow in that
tab, or the call that carries `armId`. Its opening finds the page already there (`keepPage`), so
only the typing and the click remain.

- A lapsed arm (20 minutes), a closed tab, an unknown id, another route or another browser: the
  call runs the whole leg. The arm is never trusted.
- At most 3 arms per browser; the oldest goes.
- An API leg, a spend, a read, an upload, or a flow without `prepare` answers `{armed: null}`.
- First flow: X's reply (`src/browser/flows/x-act.ts`): open the post, wait for the reply box.

## Decision log

- Title counts, not per-site badge selectors or socket frames: one regex across sites, and the
  title is what the site keeps current for its own tab. A selector per site can come later
  where the title says nothing.
- Read the title on a timer, not a MutationObserver plus `exposeFunction`: a page reload or a
  client-side route change drops an observer, a timer survives both, and a CDP read costs nothing
  on the network.
- A tab in the account's existing browser, not a browser of its own: a Chrome profile opens in
  one browser only, and a second browser costs ~300 MB.
- Matched by path and target, not only by id: the yes may reach autobrowse through layers that
  never saw the arm, and an edited reply is still the same target.
- An armed tab is a page of its own, not the parked page: another flow on the profile can run
  meanwhile without losing it.
