#!/usr/bin/env bash
# The desk worker (src/app/desk.ts) under launchd: up at login, restarted on exit.
#   install.sh           write the agent and start it
#   install.sh remove    stop it and delete the agent
# Logs: ~/Library/Logs/autobrowse-desk.log. It reads the repo's .env like the CLI.
# A second agent (DEPLOY_LABEL) runs update.mjs every minute: a new commit on main
# restarts the worker (continuous deploy). Its log: ~/Library/Logs/autobrowse-desk-deploy.log.
# A third agent (TUNNEL_LABEL) runs the Cloudflare Tunnel desk.wrenautomation.com to the
# desk's loopback listener, for wren's self-hosted Restate server. Only when its token
# file exists (TUNNEL_TOKEN; made once with the Cloudflare API). Log: autobrowse-desk-tunnel.log.
# The repo is under ~/Documents, which macOS keeps from a launchd agent until
# node has Full Disk Access (System Settings → Privacy & Security; the path
# this prints). Until then it exits "Operation not permitted" and retries.
set -euo pipefail
LABEL="com.wrenautomation.autobrowse-desk"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DEPLOY_LABEL="$LABEL-deploy"
DEPLOY_PLIST="$HOME/Library/LaunchAgents/$DEPLOY_LABEL.plist"
TUNNEL_LABEL="$LABEL-tunnel"
TUNNEL_PLIST="$HOME/Library/LaunchAgents/$TUNNEL_LABEL.plist"
TUNNEL_TOKEN="$HOME/.config/autobrowse/desk-tunnel.token"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$DEPLOY_LABEL" 2>/dev/null || true
launchctl bootout "$DOMAIN/$TUNNEL_LABEL" 2>/dev/null || true
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# bootout returns before the worker exits; bootstrap fails (5: I/O error) until it has.
for _ in $(seq 30); do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 1; done
if [ "${1:-}" = "remove" ]; then
  rm -f "$PLIST" "$DEPLOY_PLIST" "$TUNNEL_PLIST"
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
cat > "$DEPLOY_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$DEPLOY_LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$REPO/deploy/desk/update.mjs</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/autobrowse-desk-deploy.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/autobrowse-desk-deploy.log</string>
</dict>
</plist>
PLIST
launchctl bootstrap "$DOMAIN" "$PLIST"
# The worker just started on this HEAD: the deploy agent's first tick has nothing to restart.
mkdir -p "$HOME/.config/autobrowse"
printf '{"deployed":"%s","held":null}\n' "$(git -C "$REPO" rev-parse HEAD)" > "$HOME/.config/autobrowse/desk-deploy.json"
launchctl bootstrap "$DOMAIN" "$DEPLOY_PLIST"
if [ -f "$TUNNEL_TOKEN" ]; then
  cat > "$TUNNEL_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$TUNNEL_LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$(command -v cloudflared)</string><string>tunnel</string><string>--no-autoupdate</string><string>run</string><string>--token-file</string><string>$TUNNEL_TOKEN</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/autobrowse-desk-tunnel.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/autobrowse-desk-tunnel.log</string>
</dict>
</plist>
PLIST
  launchctl bootstrap "$DOMAIN" "$TUNNEL_PLIST"
  echo "desk tunnel up ($TUNNEL_LABEL); log: ~/Library/Logs/autobrowse-desk-tunnel.log"
fi
echo "desk started ($LABEL); log: ~/Library/Logs/autobrowse-desk.log; node: $NODE"
echo "deploy watching main ($DEPLOY_LABEL); log: ~/Library/Logs/autobrowse-desk-deploy.log"
