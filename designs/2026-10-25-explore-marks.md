# Explore marks: a screenshot fallback (2026-10-25)

## Goal

An explore caller always has a way to point at a control, also when no hint and no aria name finds it (an icon button, a custom widget, a name the page computes another way). The act still journals hints a compiled flow replays. Nothing presses at a point.

## Design

- `{"cmd":"marks"}`: the page's controls in view get a number, top to bottom. A layer of numbered boxes goes on (a closed shadow root, `pointer-events:none`), the viewport is shot, the layer comes off. The answer is `{file, marks:[{n, tag, role, name}]}`, names masked as `aria` masks them.
- Each marked control carries a random `data-m<hex>` attribute (one name per session), so the page never sees a tag that names autobrowse. The scripts run in Patchright's isolated world.
- `hints:{"mark":n}` works on every target. At the top of `act`, a mark becomes the control's own hints (the recorder's `HINTS_JS`, so a mark journals as a recorded act does) plus `nth`, its place among their matches. If its name finds nothing, its role, then its tag, are tried. The rest of `act` is unchanged.
- Stale: the page has no element with the mark's attribute (a load, a re-render). The act fails with "stale".
- A miss answers with marks: a Playwright timeout, a strict mode error or a stale mark, on a command with hints, single or in a batch. The answer adds `marks` and a hint. Other errors take no picture. `aria` scoped by hints that find nothing adds a hint to take marks.

## Decision log

- 2026-10-25: own numbering, not the `snapshot` rows. `snapshot` gives no element refs to share.
- 2026-10-25: custom in-page script. No maintained npm package ships set-of-marks as an injectable script, and the hints must be the recorder's own for replay. The script is small: query, visible test, hit test, sort, cap 150.
- 2026-10-25: boxes drawn in the page, not on the PNG. There is no image library here; a page layer needs none. It is on the page only for the shot.
- 2026-10-25: a mark resolves to hints and `nth`, never to a point. A point does not replay on another screen size, and the journal would hold no target.
- 2026-10-25: main frame only. A control in a cross-origin iframe (a Google button, card fields) needs a run per frame with `frame` set. Deferred: `withFrame` already finds those by hints, so the gap is small.
