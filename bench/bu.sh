#!/bin/sh
# Runs bench/bu.py with the benchmark clone's Python (designs/2026-10-27-bench.md).
set -e
here=$(cd "$(dirname "$0")" && pwd)
clone="$HOME/Library/Caches/autobrowse/bench/benchmark"
[ -d "$clone" ] || { echo "no clone: git clone --branch v2.1.1 https://github.com/browser-use/benchmark $clone && (cd $clone && uv sync)"; exit 1; }
exec uv run --project "$clone" python -I "$here/bu.py" "$@"
