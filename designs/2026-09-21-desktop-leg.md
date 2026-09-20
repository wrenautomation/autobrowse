# Desktop leg: OS actions

William, 2026-09-21: "we might want a computer application with root
access for this as well, to take the OS actions."

## Decision

Not a second app. The desktop is one more leg of the same session, next to
the browser and the terminal, so one journal → one outline → one workflow
covers a chore that crosses all three (a browser sign-up, a system setting,
a root command).

- `src/desktop/types.ts`: `Desktop` (apps, open, tree, click, type, key,
  screenshot, shell, permissions), `DesktopOp` (what the explore socket
  takes), `noDesktop` for the prod box, `fakeDesktop` for tests.
- `src/desktop/mac.ts`: System Events over JavaScript for Automation, one
  `osascript` per act with a JSON argument, `screencapture` for pictures.
  The tree is role + name like the browser's aria, so the agent and the
  compiler treat both the same. Clicks are by role and name, never pixels.
- Explore `{"cmd":"os","act":…}`; the agent has the same act with a rule to
  use it only when the goal is outside the browser and to look (`tree`)
  before clicking. Looking is not journaled; acts are.
- Compiler: a run of desktop acts is a `desktop` step; `type` values are
  plan fields, or secrets when marked `secret:true` or token-shaped; a root
  shell command makes the step irreversible (gated, like a purchase).
  Rendered steps call `deps.desktop.*` inside `fx.run`, so a replay resumes
  after the last act that finished.

## Root

`sudo` runs one root-owned helper, `/usr/local/libexec/autobrowse-root`,
allowed passwordless for this user by `/etc/sudoers.d/autobrowse`. The
helper appends the command to `/var/log/autobrowse-root.log` (root-owned)
before running it. Revoke = delete one file; audit = read one file. A bare
`NOPASSWD: /bin/sh` would be the same power with no trail.

## What a person does once

- Accessibility for the app that runs node (Terminal, iTerm, VS Code):
  System Settings → Privacy & Security → Accessibility. TCC cannot be set
  from code. `autobrowse desktop setup` opens the pane and says the state.
- The three install commands `desktop setup` prints (they ask for the
  password once).

## Not built

- Linux desktops (the prod box has none; `noDesktop` says so).
- Pixel fallback (`clickAt`) for apps with no accessibility tree; add when
  one shows up.
- Screen Recording permission check for screenshots.
