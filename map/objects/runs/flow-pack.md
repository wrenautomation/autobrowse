---
type: object
cluster: runs
universe: live
status: verified
verified: 2026-10-24 @ HEAD
entity: src/share/gate.ts
---

# Flow pack (shared library)

A compiled workflow sent to Wren after its proof passed, checked, then merged into the public registry `wrenautomation/autobrowse-flows` on William's yes. Design `designs/2026-10-24-shared-library.md`.

## Why this shape

Code from a stranger's machine must never run before a person read it. So the gate is static only; the yes is the review; the PR merges at once.

## Shape

- Queue: `shareFlow` — `src/share/share.ts:174`, called by `proveCompiled` on a `done` proof. Pack `{name, site, files, proof{at,status,steps,output: keys}}`, scrubbed, max 1 MB.
- Wren: `keepInbox` — `src/share/presidio.ts:252`: source checked (pattern entities refuse), proof lines masked; unreadable traces held at `gate/held/`.
- Gate: `checkPack` — `src/share/gate.ts:148`; `gateShared` — `:193` puts `gate/review/<id>.json` or `gate/refused/`.
- Yes: `approvePack` — `:262` (gh clone, branch, PR, squash merge). CLI `share gate|review|approve|refuse` — `src/app/cli-share.ts`.
- Install: `addFlow` — `:328`, `autobrowse workflows add <name>`; writes `.registry`.
- Nightly: `reproofRegistry` — `:368`, `reproofOnTimer` in `src/app/services.ts`; a broken flow opens one registry issue.

## Connected to

- **joins:** [[workflow]] (compiled flows, proof), [[gate]] (proofs decline gates)
- **looks-like-but-is-not:** [[gate]] (an irreversible-step approval in a run, not the registry gate)

## If you change this

- **Hits:** wren `apps/share` Worker (admin routes), the registry repo layout (`index.json`, `flows/<name>/`), `src/app/backend.ts` proveCompiled.
