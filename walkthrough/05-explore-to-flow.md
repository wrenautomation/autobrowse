# 5 · Explore → record → compile → run

**Goal:** turn one exploration of a site into a deterministic workflow the
worker serves, then run it forever with no model.

The loop: **map** the page (aria tree) → **act** one command at a time,
every act journaled → **save** the journal as a recording → **compile** it
to `src/workflows/<name>/` → **try** it. Three ways to make the journal:
explore (you or Claude Code send commands), record (you click in a headed
browser), agent (the model explores toward a goal). Same journal, same
redaction, same compile.

## Explore by hand

```sh
pnpm autobrowse explore scratch --url https://example.com --port 9090   # one hidden browser, loopback commands
S=.claude/skills/autobrowse/scripts
$S/cmd.sh 9090 '{"cmd":"aria"}'                       # every control by role and name
$S/cmd.sh 9090 '{"cmd":"click","hints":{"role":"link","name":"Learn more"}}'
$S/cmd.sh 9090 '{"cmd":"read","hints":{"role":"heading"},"as":"title"}'   # keep text as a result
$S/cmd.sh 9090 '{"cmd":"note","text":"landed on IANA"}'                   # a step boundary for the compiler
$S/cmd.sh 9090 '{"cmd":"save","name":"example-more"}'
$S/cmd.sh 9090 '{"cmd":"close"}'
```

Targets are hints: `{role, name, text, placeholder, id, testId, href,
inputType, css, nth}` — `name` is the accessible name from `aria`. Look
before you act; a miss costs a run, a look costs nothing.

Commands: `open click fill place select upload press type key aria snapshot
text url pages page screenshot eval count read keep note os pause resume
journal save close`. `place` fills a secret by name (the socket never
carries it); `keep` reads a key the page shows straight into the env store;
`os` drives the desktop (guide `../designs/2026-09-21-desktop-leg.md`).

The bearer token is in `$TMPDIR/autobrowse/explore-9090.token` for the
session's life. `explore <site>` for a logged-in site uses that site's
profile; `--headed` to watch.

## Play / pause

`{"cmd":"pause"}`: the browser is yours; every click and keystroke you make
lands in the same journal (typed secrets redacted at capture).
`{"cmd":"resume"}` hands it back. The agent re-reads the page when it resumes.

## Record

```sh
pnpm autobrowse record buy-domain --site cloudflare --url https://dash.cloudflare.com/ --terminal
```

A headed browser with an observer: clicks, typing, navigations, each with a
screenshot and locator hints (never CSS). In the terminal: `p` pauses, `q`
finishes, any other line is a note. `--terminal` records the shell leg after.

## Compile

```sh
pnpm autobrowse compile example-more            # recording → src/workflows/example-more/{index.ts, outline.json, test}
pnpm autobrowse compile example-more --no-llm   # pure template, no model pass
pnpm autobrowse compile example-more --from-outline   # after editing outline.json
```

`outline.json` is the editable truth: steps at notes and navigations, typed
inputs vs secrets, irreversible verbs, pauses → hand-offs. A model may
polish names and proofs; it can never change what runs. The Workflow page
in the UI edits the same file.

## Run

```sh
pnpm autobrowse try example-more                # in-process, real browser, no Restate
pnpm autobrowse try example-more --dry-run      # stop before the first irreversible step
pnpm autobrowse try example-more --ask          # stop at the first gate instead of approving
pnpm autobrowse try example-more --prove        # proof.json beside the flow, shown on the Runs page
pnpm autobrowse run example-more k1 --plan '{}' # durable, through Restate; approve/pause/play/status/reset
```

Compiled workflows are served as they appear (one `Compiled` object keyed
`<workflow>/<key>`, loaded per run): no restart.

## Teach by hand

Do a chore once yourself and keep it as a walk. Nothing is compiled and no
model runs.

```sh
pnpm autobrowse teach scratch join-list --url http://127.0.0.1:8765/
# do the chore in the browser, then type done
```

The build guesses where each value you typed comes from next time. Your
name or email becomes a profile value, a date becomes "today plus N days",
and anything else becomes a field with your text as its default. Each guess
gets one key: Enter keeps it, `f` fixes the text, `a` asks every run, `p`
picks a profile value, `s` makes it a secret.

```sh
pnpm autobrowse walks run scratch/join-list --plan note=hi --profile william --yes
pnpm autobrowse teach scratch join-list --url ... --mod walkthrough/mods/autobrowse-mod-scratch
```

`--mod` packs the walk into a mod folder. It refuses values that look like
an email, phone or street unless you pressed `f` on them.

## When a step breaks

A stale locator: `fp.act` asks the repairer for new hints for the same goal,
tries once, reports. Irreversible ops are never repaired; they hand off. A
failure writes `<stamp>.failure.json` + `<stamp>.aria.txt`; guide 6 picks
it up.

Demo: `demos/03-explore.sh` runs the explore lines above end to end.
