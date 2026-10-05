# Teach mode

Living doc. Started 2026-10-05. William: "a manual mode for autobrowse where you can do a workflow (not an agent) and that gets created into a deterministic workflow, but with values generalized so the workflow becomes flexible for other users / future uses."

## Answer first

`autobrowse teach <site> <name>` opens a headed browser and you do the chore by hand. When you're done, autobrowse builds a walk from that one run: data, not code, and replayed with no model. It also decides where each value should come from next time:

- your profile;
- a secret;
- a field asked for on each run, with what you typed as its default;
- or fixed.

You confirm the guesses in one short review. `--mod <dir>` packs the walk into a mod for someone else to install. Their own profile and secrets fill it.

## What exists

- `explore` already journals a person's acts (`act` rows with `hand: true`), but with no look, because the page had already changed by the time it was seen.
- `walks build` turns runs into a walk: screens by look, ops, and value sources (`plan`, `secret`, `literal`). A typed value becomes fixed only when two runs typed the same thing.
- `walks run` replays a walk, takes `--plan k=v`, and falls back to each field's example.
- `record` plus `compile` turn a recording into TS code. It stays for chores with a terminal or desktop part. Teach is the browser path, and it never writes code.
- Owner profiles (`src/money/profile.ts`): name, birthday, gender, address, email, phone and tax id. Billing forms already fill from them.

## The session

1. `autobrowse teach <site> <name> [--url <start>] [--goal <words>] [--profile <id>]` starts explore headed and paused, driver `person`, on the site's logged-in Chrome profile.
2. After each of your acts the page settles (the DOM-quiet wait), and explore takes a look. It becomes the next act's `look`, so a run taught by hand has looks like an agent's run, and `walks build` can find its screens.
3. You type `done` in the terminal, or close the browser. With no `--goal`, it asks for the goal in one line.
4. It builds and reviews (below), writes the walk, and prints the command to run it.

Teach the same name again and that run is added to the walk's runs. The build then uses every run, as `walks build` does today. A value that was the same each time stays fixed, unless the review said otherwise.

## Where values come from

The build guesses in this order, and the first match wins.

| You typed | Becomes | Why |
|---|---|---|
| a secret, or a field the redactor hid | `{from: "secret"}` | as today |
| exactly a profile value: full, first or last name, email, phone, a line of the address, city, postal code, country, birthday | `{from: "profile", field}` | it's about who runs it, so another user's profile fills it |
| a date | a field whose default is relative to the day you taught it (`today+3d`) | a fixed date is wrong tomorrow |
| a number or an id that also shows in the URL you landed on | a field, and the URL becomes a template (`/projects/{project}`) | the same flow on another record |
| anything else | a field asked each run, defaulting to what you typed | safe default: never silently fixed |

Clicks:

- A click whose target text equals a field's value, such as picking the search result you just typed, targets `{field}`. It follows the value, not the row.
- Other clicks stay as they are.
- A select stays fixed, and the review can make it a field with the options it saw.

The walk spec bumps `WALK_VERSION` to 2:

- `valueSchema` gains `{from: "profile", field}`;
- fields gain an optional `default` (literal or `today+Nd`) and `options`;
- `open.url` and click hints may name `{field}`.

Version 1 walks still load unchanged.

## Review

Each value is one line, `label · what you typed · guess`. You keep the guess with Enter, or press `f` for fixed, `a` for ask each run, `p` for profile, or `s` for secret. There's one screen in the terminal, and `--yes` takes every guess. Secrets are never shown, only their labels.

## Running it

`autobrowse walks run <site> <name> [--plan k=v] [--profile <id>]`:

- A field with no value and no default is asked for in the terminal, or with `--ask` when a model drives.
- Profile fields come from `--profile`, else the only profile there is.
- The wren `sites` facade and MCP take the same plan object.

## Mods

`--mod <dir>` writes the walk to `<dir>/walks/<site>/<name>.json` and adds it to `mod.json`, as `walkthrough/mods/autobrowse-mod-scratch` does. Publishing stays the mods doc's step (a version bump, then publish).

A walk with fixed values that look personal won't pack until the review says so. Those values are an email, a phone or an address that isn't from the profile.

## Phases

- T1. Looks after hand acts in explore, plus `teach` (the session, a single-run build, writing the walk).
- T2. Value guessing: profile, date, URL id, click-by-field. Then spec v2, with `walks run` reading it.
- T3. The review screen, `--yes`, and `--mod` packing with the personal-value check.
- T4. An end-to-end test on the scratch site:
  1. Teach the localhost join-list form by hand, scripted through the page as a person would.
  2. The name and email become profile values, and the note becomes a field.
  3. Replay with another profile and another note, and land on the thank-you page.

  Plus the docs: README, the map's `walk` card, and `walkthrough/`.

## Done when

- The T4 test passes in `pnpm -s gates`.
- A real chore taught on William's Mac replays from a fresh terminal with a different field value. Pick one with no spend and no posting, such as a newsletter signup to his own inbox.
- The scratch mod republishes with a taught walk in it.

## Decision log

- 2026-10-05: Written. Build on walks, not `record` plus `compile`: walks are data, so they pack, diff and run with no model, and compile writes code a buyer has to trust. One run is enough. Ask-each-run with a default is the safe guess, so nothing personal gets frozen in by accident. Profile is the "other users" seam: the same walk runs as whoever's profile is loaded.
