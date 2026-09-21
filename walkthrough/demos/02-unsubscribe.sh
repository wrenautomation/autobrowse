#!/bin/bash
# The inbox's mailing lists over the last 45 days: sender, count, how it can be left, latest subject.
# List only: nothing leaves without --yes, and that is yours to run.
set -uo pipefail
cd "$(dirname "$0")/../.."
pnpm -s autobrowse unsubscribe --days "${DAYS:-45}" ${KEEP:+--keep "$KEEP"}
