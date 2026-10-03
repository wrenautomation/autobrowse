---
type: object
cluster: access
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/channels/types.ts
---

# Channel

Where run events reach people and systems, and where their replies come back as commands: `Channel` in `src/channels/types.ts`; email, phone (iMessage on this Mac), Linq, webhook, forward, memory.

## Why this shape

One shape for delivery and one parser for replies, so a `yes` by SMS, email or webhook is the same command. Fan-out never lets one channel's failure stop a run (`channels(list)`, `src/channels/types.ts:20-30`). `note` is a bare line to a person outside any run ("tap Yes on your phone").

## Shape

- `Channel { name, deliver(event), note?(text) }` — `src/channels/types.ts:8-18`
- `forwardChannel`: posts a run's events to the hook its caller named (`deliver(event, feed)`), `{ tag, traceparent?, events: [{ seq, event }] }` every second or 20 events, bearer `FEED_TOKEN`, https on `FEED_HOSTS` only, no redirects, at most 500 held per feed (oldest dropped); never fails the run. On when `FEED_HOSTS` is set — `src/channels/forward.ts:41-116`, `src/app/services.ts:1104-1138`, settings `src/app/config.ts:143-145`
- `Command`, `RunSpec`, `parseCommand(text)` (`yes`, `no`, `pause`, `play`, `status`, `reset`, optional `<workflow> <key>`) — `src/channels/commands.ts:6-31`
- Rendering: `src/channels/render.ts`; inbound: `/hooks/inbound`, `/hooks/linq` — `src/ui/api.ts:889-903`; wired by `channelsFor` — `src/app/services.ts:1130`
- The phone as a device (read SMS, send iMessage): `phoneReader`, `phoneNotifier`, `phoneStatus` — `src/devices/phone.ts:78-137`

## Connected to

- **owned-by:** [[app]] (`App.channel`)
- **joins:** [[run-event]], [[gate]] (answers), [[approval]] (`askOverChannel`), [[sign-in-context]] (`notify`), [[card]] (charge notes), the UI bus

## If you change this

- **Hits:** `src/channels/*.ts`, `src/gates/ask.ts`, `src/app/services.ts:1110`, `src/ui/api.ts:889`, `src/devices/phone.ts`.
- **Does not hit:** the run object's logic (it only emits).

## Surfaces

| Surface | Role |
|---|---|
| a person | reads, replies |
| run object, gates | write |

## See

- Source: `src/channels/types.ts`, `src/channels/commands.ts`
