# Browser lifecycle: held sessions, a browsers doctor, profile locks (2026-10-06)

William, 10-06: "a long running version of autobrowse where the agent is responsible for starting and stopping ... only for rare cases where multi loops / lots of hitl intervention ... a doctor like command [to] manage autobrowse instances and memory ... give the agent some sort of say when something might be wrong with how the connection management was handled ... or connection pooling but for chrome browsers? ... if you see utility, bake them into plans and make them."

## Answer first

Most of this exists. What's missing is seeing it and two safety fixes.

- **Long-running sessions exist:** the explore server lives until `close` or 30 minutes idle, and resumes from its journal. Teach never times out. The gap: an agent waiting on a person longer than 30 minutes loses its browser. Build `explore --hold`: no idle timeout, the agent must stop it, and the doctor flags a held session over 12 hours.
- **Pooling exists where it pays:** `SessionPark` keeps up to 2 warm Chromes per long-lived worker (desk, box) for 10 minutes. A one-shot CLI stays one-shot on purpose; an agent that wants a warm browser across calls uses an explore session. No new pool.
- **Build `autobrowse browsers`:** every Chrome on this machine under the profiles dir, with owner, age and memory, plus every explore server with idle time and held flag. `browsers stop <target>` closes one safely.
- **The doctor speaks up:** `doctor` gets a browsers section that warns, each with the command that fixes it.
- **Two fixes:** close parked sessions on SIGTERM/SIGINT (`SessionPark.closeAll` is never called today), and a cross-process profile lock check before a local launch, so a second process on the same profile fails with who holds it instead of Chrome's own error.

## `autobrowse browsers`

One row per root Chrome process whose `--user-data-dir` is under the profiles dir, and one per explore server token file.

- **Owner:** `desk` (parent is the desk worker), `worker` (box/engine worker), `explore:<port>`, `agent:<port>`, `teach`, `cli` (parent is a live autobrowse CLI), `orphan` (ppid 1, what `reap` kills). The person's own browser is never listed as ours.
- **Columns:** pid, owner, profile, age, memory (RSS of the process tree, MB), and for explore servers idle minutes and `held`.
- **Totals:** Chrome processes, total MB, share of the machine's RAM.
- `--json` for agents.
- `browsers stop <pid|port|profile>`: an explore server gets its `close` command (journal kept unless `--forget`); an orphan gets SIGTERM; a `cli` process gets SIGTERM with `--force` only. Refused, with the reason: desk- or worker-owned Chromes (they hold a gate's half-filled page), and the person's own browser.

## Doctor: browsers section

Warnings, each one line with its fix:

| Warning | Fix it names |
|---|---|
| Orphan Chrome under the profiles dir | `autobrowse reap` |
| Explore server idle over 2 hours, not held | `autobrowse browsers stop <port>` |
| Held session over 12 hours | stop it, or say why it's still needed |
| Two live processes on one profile | stop one; which is which |
| A profile's `SingletonLock` names a live process that isn't ours | close that Chrome |
| One Chrome over 1.5 GB, or all over 50% of RAM | `autobrowse browsers` to see which |
| More than 4 explore servers | stop the idle ones |

Thresholds are named constants at the top of the module.

## Held sessions

- `explore --hold` (and `start.sh --hold`): idle timeout off. The token file records `held: true` and when it started.
- `state.sh` and `browsers` show held sessions with their age.
- The skill doc says: hold only for multi-loop or long human-in-the-loop work; you stop it yourself (`stop.sh`); a held session you forget is flagged by `doctor`.

## Fixes

1. Workers (`main.ts`, `desk.ts`): on SIGTERM and SIGINT, `park.closeAll()` before exit, so parked Chromes don't outlive the worker.
2. Before a local `launchPersistentContext`: read the profile's `SingletonLock` (a symlink to `<host>-<pid>`). Pid alive and not this process: throw `profile <name> is open in pid <pid> (<owner>)`. Dead pid: leave it, Chrome clears it.

## Not built

- A browser pool for one-shot CLI calls: the explore server already is one.
- Memory limits that kill: the doctor reports, a person or agent decides.

## Decision log

- 2026-10-06: Planned from William's ideas; built as above.
