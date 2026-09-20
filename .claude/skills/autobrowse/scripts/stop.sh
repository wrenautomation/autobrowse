#!/bin/bash
# stop.sh [port]  → close the session (browser and socket); the token file goes with it.
PORT=${1:-9090}
"$(dirname "$0")/cmd.sh" "$PORT" '{"cmd":"close"}'
