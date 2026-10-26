# settings.json: the env file keeps secrets only

2026-10-26, WA-876.

## Problem

The operator's env file held 241 names. About 45 were settings, not secrets: buckets, ports, URLs, model names. Settings and secrets sat in one file, and a secret file is a bad place to edit a port.

## Target

- `~/.config/autobrowse/settings.json` holds the settings that are no secret, by field name (`logLevel`, `browser`).
- The env file holds secrets only.
- Order, first wins: the process env, `settings.json`, the env file, the default in `config.ts`.
- One schema checks all three. A bad value, an unknown name or a secret name in the file stops the boot and names the field.
- `autobrowse settings [name] [--all]` shows each value and where it came from. A secret shows only "set".
- `settings set|unset` checks the value as the boot does. Each change goes to `settings-changes.jsonl` beside the file.
- `boot` names each setting still in the env file, on stderr.
- `env pull` writes settings to `settings.json` and secrets to the env file.

## Decisions

- A secret is known by its name (`…TOKEN`, `…KEY`, `…SECRET`, `…DSN`, `…HEADERS`, `…_AUTH`, `…PASSWORD`). A name list would rot.
- The file fills `process.env` before the env file loads. The rest of the code still reads one env, so owners, `loadSettings` and the SSM store do not change.
- Strings, numbers and booleans in the file are read as the env gives them, then checked by the field's own zod check (`checkSetting`).
- No config library. c12 or zod-config would bring layers, watchers and formats this does not use. The merge is one loop over one schema.
- The file is read once at boot. The desk takes a change on its next restart or deploy. `limits.json` is different: it is read again on change, because limits change while the desk runs.

## Not in this change

- Secrets that nothing in autobrowse src reads (wren's keys, Stripe test keys, tunnel tokens) stay in the env file. Moving them to credvault keys is a separate task.
