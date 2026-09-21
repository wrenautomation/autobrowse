#!/bin/bash
# Which account is for what, and everything only you can give. Reads only; addresses, never a value.
set -uo pipefail
cd "$(dirname "$0")/../.."
echo "== accounts and their purposes"
pnpm -s autobrowse accounts
echo
echo "== open needs (each with its check and the command that clears it)"
pnpm -s autobrowse needs
