#!/bin/bash
# state.sh → what is live right now: open sessions, journals a dead session left, profiles,
# the facade's sites and the compiled workflows.
# Read into the skill at load; never fails, never prints a token, stays under ~2 s.
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
DIR=${TMPDIR:-/tmp}/autobrowse
open=""
for t in "$DIR"/explore-*.token; do
  [ -f "$t" ] || continue
  p=${t##*/explore-}; p=${p%.token}
  site=$(pgrep -fl "explore .* --port $p" 2>/dev/null | sed -nE 's/.*explore ([^ ]+) --port.*/\1/p' | head -1)
  open+="${p}${site:+ ($site)} "
done
echo "- open sessions: ${open:-none}"
j=$(ls "$ROOT"/recordings/.explore-*/journal-*.jsonl 2>/dev/null | head -8 |
  while read -r f; do s=${f%/journal-*}; s=${s##*/.explore-}; id=${f##*/journal-}; echo -n "$s ${id%.jsonl} ($(wc -l <"$f" | tr -d ' ') acts) · "; done)
echo "- resumable journals: ${j:-none}"
P=${PROFILES_DIR:-$HOME/.config/autobrowse/profiles}
prof=$(ls "$P" 2>/dev/null | grep -v @ | tr '\n' ' ')
per=$(ls "$P" 2>/dev/null | grep -c @)
[ "${per:-0}" -gt 0 ] && prof+="(+$per per-account: <site>@<label>)"
echo "- profiles: ${prof:-none}"
sites=$(grep -ho '^  site: "[a-z-]*"' "$ROOT"/src/sites/*.ts 2>/dev/null | sed -E 's/.*"(.*)"/\1/' | sort | tr '\n' ' ')
echo "- site APIs: ${sites:-none}"
wf=$(ls -d "$ROOT"/src/workflows/*/ 2>/dev/null | sed -E 's#.*/workflows/##; s#/$##' | grep -v '^example-' | tr '\n' ' ')
echo "- compiled workflows: ${wf:-none}"
exit 0
