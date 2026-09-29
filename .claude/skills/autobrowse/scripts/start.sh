#!/bin/bash
# start.sh <site> [url] [port] [explore flags…]  → one explore session in the background; prints the port when it takes commands.
# The token lands in $TMPDIR/autobrowse/explore-<port>.token (owner-only); cmd.sh reads it, nothing prints it.
set -euo pipefail
SITE=${1:?site}; URL=${2:-}; PORT=${3:-9090}
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
DIR=${TMPDIR:-/tmp}/autobrowse; mkdir -p "$DIR"; chmod 700 "$DIR"
TOKEN="$DIR/explore-$PORT.token"; LOG="$DIR/explore-$PORT.log"
if [ -f "$TOKEN" ] && curl -s -m 3 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(cat "$TOKEN")" "http://127.0.0.1:$PORT/" -d '{"cmd":"url"}' | grep -q 200; then
  echo "port $PORT already open"; exit 0
fi
rm -f "$TOKEN"
ARGS=(explore "$SITE" --port "$PORT"); [ -n "$URL" ] && ARGS+=(--url "$URL")
[ $# -gt 3 ] && ARGS+=("${@:4}")  # --signup/--codes/--login/--headed: what place may type
(cd "$ROOT" && nohup pnpm -s autobrowse "${ARGS[@]}" >"$LOG" 2>&1 &)
for _ in $(seq 1 120); do
  [ -f "$TOKEN" ] && { echo "port $PORT"; echo "log $LOG"; exit 0; }
  if ! pgrep -qf "explore $SITE --port $PORT"; then sleep 1; [ -f "$TOKEN" ] && { echo "port $PORT"; exit 0; }; echo "explore exited; log:"; sed 's/[A-Za-z0-9_-]\{30,\}/<tok>/g' "$LOG" | tail -20; exit 1; fi
  sleep 1
done
echo "no token after 120s; log:"; sed 's/[A-Za-z0-9_-]\{30,\}/<tok>/g' "$LOG" | tail -20; exit 1
