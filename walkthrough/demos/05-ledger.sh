#!/bin/bash
# Where secrets went and what the payment gate decided. Names, hosts, amounts; never a value.
set -uo pipefail
cd "$(dirname "$0")/../.."
echo "== credentials stored (names only)"
pnpm -s autobrowse creds list
echo
echo "== last 10 secret uses"
pnpm -s autobrowse creds audit --last 10
echo
echo "== last 10 gate decisions"
pnpm -s autobrowse spend --last 10
