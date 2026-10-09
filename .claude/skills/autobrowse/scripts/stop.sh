#!/bin/bash
# stop.sh [port] [achieved|failed] [summary]  → say how the run ended, then close the session
# (browser and socket); the token file goes with it. Without an outcome the run is kept as
# "closed": no verdict, which `autobrowse success` counts as unknown.
PORT=${1:-9090}
OUTCOME=$2
SUMMARY=$3
if [ -n "$OUTCOME" ]; then
  case "$OUTCOME" in achieved|failed) ;; *) echo "outcome: achieved or failed" >&2; exit 2 ;; esac
  "$(dirname "$0")/cmd.sh" "$PORT" "$(node -e 'const [o,s]=process.argv.slice(1);console.log(JSON.stringify({cmd:"done",outcome:o,...(s?{summary:s.slice(0,500)}:{})}))' "$OUTCOME" "$SUMMARY")" >/dev/null
fi
"$(dirname "$0")/cmd.sh" "$PORT" '{"cmd":"close"}'
