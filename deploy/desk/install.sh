#!/usr/bin/env bash
# The desk worker (src/app/desk.ts) under launchd: up at login, restarted on exit.
#   install.sh           write the agent and start it
#   install.sh remove    stop it and delete the agent
# Logs: ~/Library/Logs/autobrowse-desk.log. It reads the repo's .env like the CLI.
# The repo is under ~/Documents, which macOS keeps from a launchd agent until
# node has Full Disk Access (System Settings → Privacy & Security; the path
# this prints). Until then it exits "Operation not permitted" and retries.
set -euo pipefail
LABEL="com.wrenautomation.autobrowse-desk"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [ "${1:-}" = "remove" ]; then
  rm -f "$PLIST"
  echo "desk removed"
  exit 0
fi
# The real binary: macOS privacy grants follow it, not the Homebrew symlink.
NODE="$(realpath "$(command -v node)")"
NODE_DIR="$(dirname "$NODE")"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$REPO/node_modules/tsx/dist/cli.mjs</string><string>src/app/desk.ts</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/autobrowse-desk.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/autobrowse-desk.log</string>
</dict>
</plist>
PLIST
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "desk started ($LABEL); log: ~/Library/Logs/autobrowse-desk.log; node: $NODE"
