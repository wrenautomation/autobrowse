#!/bin/bash
# cmd.sh <port> '<json>'  → POST one command to the session; the answer is JSON, already masked by the socket.
set -uo pipefail
PORT=${1:?port}; BODY=${2:?json}
TOKEN="${TMPDIR:-/tmp}/autobrowse/explore-$PORT.token"
[ -f "$TOKEN" ] || { echo "{\"error\":\"no session on $PORT: run start.sh\"}"; exit 1; }
curl -s -m 120 -X POST -H "Authorization: Bearer $(cat "$TOKEN")" "http://127.0.0.1:$PORT/" -d "$BODY"
echo
