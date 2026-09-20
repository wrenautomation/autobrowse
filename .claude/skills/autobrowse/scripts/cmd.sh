#!/bin/bash
# cmd.sh <port> '<json>'  → POST one command; JSON back, already masked. Page commands queue behind each other (one hand);
# an `open` that signs in can take minutes, so the request waits up to 15 min.
# A payment gate holds the request (?wait=1) while the person is texted: yes → the act runs, no → 403.
# If curl's 15 min run out first, the same command is re-sent and joins the pending ask, up to ~31 minutes.
set -uo pipefail
PORT=${1:?port}; BODY=${2:?json}
TOKEN="${TMPDIR:-/tmp}/autobrowse/explore-$PORT.token"
[ -f "$TOKEN" ] || { echo "{\"error\":\"no session on $PORT: run start.sh\"}"; exit 1; }
for _ in 1 2 3; do
  OUT=$(curl -s -m 900 -w '\n%{http_code}' -X POST -H "Authorization: Bearer $(cat "$TOKEN")" "http://127.0.0.1:$PORT/?wait=1" -d "$BODY")
  RC=$?
  if [ $RC -eq 28 ]; then continue; fi   # timed out on the wire: the ask is still pending server-side
  CODE=${OUT##*$'\n'}; RES=${OUT%$'\n'*}
  echo "$RES"; [ "$CODE" = "200" ] && exit 0 || exit 1
done
echo '{"error":"no answer in 45 minutes","gate":"payment","reason":"no-answer"}'; exit 1
