#!/bin/bash
# How `do` routes three goals: a site route, a compiled workflow, nothing ready. Runs nothing.
set -uo pipefail
cd "$(dirname "$0")/../.."
for goal in "list my youtube videos" "rename my google account" "post a story on snapchat"; do
  echo "== do \"$goal\" --dry-run"
  pnpm -s autobrowse do "$goal" --dry-run --input name=Wren
  echo
done
echo "== abilities (first 20)"
pnpm -s autobrowse abilities | head -20
