#!/bin/bash
# What every site can do right now, one site in detail, one real read on YouTube.
# Reads only. Long tokens are masked before printing.
set -uo pipefail
cd "$(dirname "$0")/../.."
mask() { sed 's/[A-Za-z0-9_-]\{30,\}/<tok>/g'; }

echo "== sites"
pnpm -s autobrowse site | mask
echo
echo "== youtube, route by route"
pnpm -s autobrowse site status youtube | mask
echo
echo "== the channel behind the token (YouTube Data API v3)"
pnpm -s autobrowse site call youtube GET "/youtube/v3/channels?part=snippet,statistics&mine=true" | mask
