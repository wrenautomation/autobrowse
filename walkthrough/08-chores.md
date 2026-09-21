# 8 · Chores: unsubscribe

**Goal:** the inbox off every mailing list the fleet/tool/registry signups
put it on, hands-off, without touching mail you did not opt into.

```sh
pnpm autobrowse unsubscribe --days 45                    # list: sender, count, path, latest subject
pnpm autobrowse unsubscribe --days 45 --keep wrenautomation.com,github.com
pnpm autobrowse unsubscribe --yes --only news@x.io,hi@tool.io    # leave these
pnpm autobrowse unsubscribe --yes --keep wrenautomation.com      # leave every listed sender
pnpm autobrowse unsubscribe --yes --no-browser           # never open a link; report those instead
```

What it does (`src/chores/unsubscribe.ts`):

1. Gmail API (`gmail` site, the consented account or `--account`): messages
   `newer_than:<days>d unsubscribe`, paged; each read as metadata only.
2. Only senders whose mail carries `List-Unsubscribe` are listed — a
   receipt, a code, a person has none, so they are never touched.
3. `--yes` leaves each one by the cheapest path that works: **one-click**
   (`List-Unsubscribe-Post`, an HTTP POST), else **mailto** (a mail sent
   from the same account), else the **link** opened in the browser and its
   unsubscribe/confirm button clicked (`--no-browser` reports it instead).
4. One line per sender: `one-click | mailto | link | none`, ok or why not.

Nothing leaves without `--yes`. The list is yours to read first; the paste-
ready `--only` list for the recent signups is in `../NEEDS-WILLIAM.md`.

Demo: `demos/02-unsubscribe.sh` (list only).
