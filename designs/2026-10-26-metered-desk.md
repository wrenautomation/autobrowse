# Desk on a metered network

WA-887. On the iPhone hotspot the Mac used about 2 GB in a few hours. The desk's calls are small JSON. The bulk came from shared-library uploads, the ingest pulls with presidio, and deploy restarts.

## Target

The desk stays up on the hotspot and serves calls. Bulk work waits for wifi, then runs as usual. No queue is lost.

## What holds

| Work | Where | On wifi |
|---|---|---|
| trace backup and sweep | `keepTracesOnTimer` | next tick (15 min) |
| shared-library sends | `sendSharedOnTimer` | durable queue drains, 120 s per tick |
| ingest pulls, presidio, flow gate | `keepSharedOnTimer` | next hourly tick |
| registry re-proofs | `reproofOnTimer` | next nightly tick |
| shot ships (worker timer) | `main.ts` | next tick |
| deploy restart, wren-desk fetch | `deploy/desk/update.mjs` | next minute |

Calls, watchers, UI and Restate registration keep running. Typed commands (`shots push`, `traces push`, `share send`) do not hold: a typed command is a person's yes.

## Decision log

- 2026-10-26: one source of truth, `~/.config/metered/metered.sh status`. Rule: hold if mode is `on`, or mode is `auto` and the network is metered. The script's second field ignores the mode, so the mode is read first.
- 2026-10-26: no script, a failed script or bad output: no hold. The box and a fresh Mac never hold by accident.
- 2026-10-26: no new setting or env. The mode file (`metered.sh set on|off|auto`) is the override.
- 2026-10-26: re-proofs hold too. They drive Chrome through registry flows and serve no call.
- 2026-10-26: one log line per change of network, not one per tick. The deploy agent logs once per change through its state file.
- 2026-10-26: when this landed, `com.williamjin.metered` could drop the desk and deploy labels from its JOBS list.
