#!/bin/bash
# cmd.sh <port> '<json>'  → POST one command to the session; the answer is JSON, already masked by the socket.
# A payment gate answers 202 {"reason":"asked"} while the person is being texted: this re-sends the
# same command every 30 s until they answer (yes → the act runs, no → 403), up to 31 minutes.
set -uo pipefail
PORT=${1:?port}; BODY=${2:?json}
TOKEN="${TMPDIR:-/tmp}/autobrowse/explore-$PORT.token"
[ -f "$TOKEN" ] || { echo "{\"error\":\"no session on $PORT: run start.sh\"}"; exit 1; }
for _ in $(seq 1 62); do
  OUT=$(curl -s -m 120 -w '\n%{http_code}' -X POST -H "Authorization: Bearer $(cat "$TOKEN")" "http://127.0.0.1:$PORT/" -d "$BODY")
  CODE=${OUT##*$'\n'}; RES=${OUT%$'\n'*}
  if [ "$CODE" = "202" ]; then sleep 30; continue; fi
  echo "$RES"; [ "$CODE" = "200" ] && exit 0 || exit 1
done
echo "$RES"; exit 1
