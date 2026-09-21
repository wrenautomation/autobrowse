#!/bin/bash
# Map a public page by its aria tree, journal two acts, save the recording, compile it, try the flow.
# No login, no model (compile --no-llm), nothing irreversible.
set -uo pipefail
cd "$(dirname "$0")/../.."
PORT=${PORT:-9093}
S=.claude/skills/autobrowse/scripts
NAME=demo-example-more

echo "== start an explore session on example.com (port $PORT)"
$S/start.sh scratch https://example.com "$PORT"
echo
echo "== aria: the page as controls"
$S/cmd.sh "$PORT" '{"cmd":"aria"}'
echo
echo "== act: follow the one link, read the heading"
$S/cmd.sh "$PORT" '{"cmd":"click","hints":{"role":"link","name":"Learn more"}}'
$S/cmd.sh "$PORT" '{"cmd":"read","hints":{"role":"heading","nth":0},"as":"title"}'
$S/cmd.sh "$PORT" '{"cmd":"url"}'
echo
echo "== save the journal as a recording, close"
$S/cmd.sh "$PORT" "{\"cmd\":\"save\",\"name\":\"$NAME\"}"
$S/stop.sh "$PORT"
echo
echo "== compile it (pure template) and run it here"
pnpm -s autobrowse compile "$NAME" --no-llm
pnpm -s autobrowse try "$NAME"
echo
echo "compiled flow: src/workflows/$NAME/ (delete it when done: rm -r src/workflows/$NAME recordings/$NAME*)"
