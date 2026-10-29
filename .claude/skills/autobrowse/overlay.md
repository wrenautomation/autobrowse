# Overlay: the terminal panel over the page

A visual for a person who watches a headed page: a panel and pulsing purple boxes.
It is in a closed shadow root outside `body`. Your acts and the aria tree never see it.
It is off for every screenshot and every film frame. Nothing depends on it, so remove it freely.

## Where it shows

| Run | Default | Turn it on or off |
|---|---|---|
| explore session | on when headed | `{"cmd":"overlay","on":false}` / `"on":true`, any time |
| `autobrowse try <wf>` | on with `--headed`, off with `--film` | `--overlay` / `--no-overlay` |
| flows on the worker or desk | off (real accounts; a page script can see the node) | `AUTOBROWSE_OVERLAY=on` |

`AUTOBROWSE_OVERLAY=auto|on|off` sets the default for every run. A flag wins over it.

## What it shows

- The bar: the goal (explore: what you set; a flow: `site/flow`) and the run's seed.
- A busy line while a command runs: phase words (locating, aiming, clicking) and a spinner.
  Between commands, with a goal set: "thinking".
- The trace: one row per command or flow step. Each row has the aim, ✓/✗, ms and a dim note
  (where the page went, controls added and gone, chars read). It never shows a typed value or a query string.
- The act's control pulses purple before the hands reach it.

## Buttons

- `[●]` (default): the panel takes clicks (expand a row, scroll the trace). The page never sees them.
- `[○]`: clicks pass through the panel to the page. Only the buttons and the grip take them.
- `[▸]`/`[◂]` moves it to the other side. `[_]`/`[+]` folds it.
- `[×]` hides it to a chip at the bottom (`▌autobrowse ○ show`). Click the chip to show it again.
- Drag the top corner grip to resize it.
- Each choice carries to the next page. While a command runs, the whole panel lets clicks through.

## Drive it (explore)

- `{"cmd":"overlay","goal":"…","step":"3 of 8","thought":"…"}`: panel fields. Set the goal
  first, then a thought before each act that needs a why.
- `refs:[{n,hints}]` boxes controls with numbers; `clear:true` empties the fields.
- `on:false` takes it down and keeps the trace; `on:true` draws it again.
- It takes no part in your acts and no row in the run's history.

## Record a run once

`autobrowse try <wf> --headed --film [dir]` writes one mp4 per page plus a JSON log
(default `~/.config/autobrowse/films/<wf>-<time>/`). The film is clean: no overlay, no cursor.
The pane JSON holds every hand act and one `step` event per flow step (cmd, aim, ✓/✗, ms, note).
An editor draws the overlay and the cursor from it afterwards. Send the mp4. Never run the flow again to show it.
