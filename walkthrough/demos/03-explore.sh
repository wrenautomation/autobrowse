#!/bin/bash
# Tier 0: map a public page by its aria tree, journal two acts, save the recording, compile it, try the flow.
# No login, no model (compile --no-llm), nothing irreversible. CLI verbs only.
# Outside this repo: AB="npx @wrenautomation/autobrowse" walkthrough/demos/03-explore.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
AB=${AB:-pnpm -s autobrowse}
PORT=${PORT:-9093}
NAME=demo-example-more

echo "== start an explore session on example.com (port $PORT)"
$AB explore scratch --url https://example.com --port "$PORT" --background || exit 1
echo
echo "== aria: the page as controls"
$AB cmd --port "$PORT" '{"cmd":"aria"}'
echo
echo "== act: follow the one link, read the first paragraph"
$AB cmd --port "$PORT" '{"cmd":"click","hints":{"role":"link","nth":0}}'
$AB cmd --port "$PORT" '{"cmd":"read","hints":{"role":"paragraph","nth":0},"as":"text"}'
$AB cmd --port "$PORT" '{"cmd":"url"}'
echo
echo "== save the journal as a recording, close"
$AB cmd --port "$PORT" "{\"cmd\":\"save\",\"name\":\"$NAME\"}"
$AB cmd --port "$PORT" '{"cmd":"close"}'
echo
echo "== compile it (pure template) and run it here"
$AB compile "$NAME" --no-llm
$AB try "$NAME"
echo
echo "compiled flow: $NAME (\`$AB abilities $NAME\` shows it)"
