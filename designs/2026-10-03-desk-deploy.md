# Desk deploy

The desk worker runs this checkout under launchd (`deploy/desk/`). Before this,
a commit reached it only when someone restarted it by hand, so the HTTP API
changes in 2f38a65 sat unused until a restart.

## Shape

`deploy/desk/update.mjs` runs every minute as a second launchd agent
(`com.wrenautomation.autobrowse-desk-deploy`). Each tick:

1. Off `main`: do nothing.
2. HEAD equals the deployed commit (`~/.config/autobrowse/desk-deploy.json`): do nothing.
3. Uncommitted edits under `src/`, `package.json` or `pnpm-lock.yaml`: hold, log once.
4. No change under those paths since the deployed commit: record HEAD, no restart.
5. Lockfile changed: `pnpm install --frozen-lockfile`.
6. `launchctl kickstart -k` the desk, record HEAD, wait up to 2 minutes for
   "desk up" in its log. No "desk up", or any step throws: #ops on Discord,
   with a mention.

`install.sh` writes both agents and seeds the state with HEAD, since it has just
started the worker on it. Log: `~/Library/Logs/autobrowse-desk-deploy.log`.

## Decision log

- 2026-10-03: poll with launchd, not a git hook. A post-commit hook fires for
  every repo user's commit, including mid-rebase ones, and misses `git pull`.
  A one-minute poll costs a `git rev-parse`.
- 2026-10-03: no `git pull`. Every commit is made in this checkout, so HEAD is
  the release. Pulling into a checkout other sessions edit could move files
  under them.
- 2026-10-03: a dirty `src/` holds the deploy. The worker loads files from
  disk, so a restart mid-edit would ship half a change.
- 2026-10-03: a commit that will not boot is recorded as deployed and reported
  once. launchd keeps retrying the worker; the next commit is the fix.
- 2026-10-03: plain node, no tsx. launchd's node binary holds the Full Disk
  Access that `~/Documents` needs, and the script has no imports from `src/`.
