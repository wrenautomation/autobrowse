# Explore gaps: what the tree misses, and a headed overlay

2026-10-27. Tasks WA-909, WA-910, WA-911.

## Goal

The agent sees every control a person can click. A person who watches a headed run sees what the agent sees and why it acts.

## What the tree missed

The agent reads Playwright's aria snapshot. Two kinds of control were not in it:

1. **Controls in a closed shadow root.** Patchright's locators reach them (`getByRole`, CSS, `*`). The aria snapshot does not. Test on 10-27: a closed-root button was absent from `ariaSnapshot()`, and `getByRole` found it.
2. **Elements that are clickable only by script.** A card with `addEventListener('click')` and no role shows as text, with no ref.

Canvas apps (Docs, Figma) stay out of scope. They have no elements. Use their APIs.

## Design

One mechanism closes both gaps: `extrasOf(page)` in `src/browser/extras.ts`.

- One `page.locator("*").evaluateAll` pass. Patchright's `*` walks closed roots, so one pass sees every element.
- An extra is one of:
  - a control (the same selector set the tree gives refs to) inside a closed root;
  - an element with `onclick`, a `tabindex`, or `cursor: pointer` that is outermost (its parent is not pointer), holds no control, is no label, and has a box.
- Each extra gets hints, checked against the element: its own hints, then its first text line as a regex, then its tag. The first whose matches hold the element wins, with `nth`.
- At most 20 extras. A feed page must not bury the outline.
- The `aria` command takes `extras: true`. The agent asks for it every step. The digest lists them last under `not in the tree:`, with code `D` for a clickable with no role. A ref on an extra carries its hints; `hintsFor` returns them as they are.
- `marks` also numbers pointer cards, with the same outermost rule.

## Overlay (headed only)

`src/explore/overlay.ts`. It is on by default when the session is headed (`ExploreOptions.overlay` turns it off).

- **Boxes** on the outline's refs, with the same numbers the model reads. The agent sends `{"cmd":"overlay", refs}` after each digest. Each box resolves through the ref's own hints (400 ms cap, in parallel), so a number on screen is the number in the prompt.
- **Target flash.** Before every act with hints, the server draws a pulsing box on the target, and the panel shows the act and its `goal`. This works for any driver, a Claude Code session included.
- **Panel**, bottom left until dragged: step `n of max`, the goal, the model's thought, the act under way, the trace. Decorative: its body lets every click through. The bar drags it anywhere, the corner grip sizes its width and height, `[◆]` turns the boxes and flash off (then they are not looked up), `[_]` folds it to a tab at the left edge.
- After an act, the boxes go: the page may have changed. A new document redraws the panel.
- The layer is a fixed host on `<html>`, outside `body`, with a closed shadow root and `pointer-events: none`. The aria tree does not read it, `elementFromPoint` passes through it, and presses reach the page.
- It is taken off for every screenshot (`shoot`, the run pictures, the receipt shot) and on `close`.
- `overlay` is a session control: it never waits behind an act, opens a run, or writes a command row.

## Decision log

- **2026-10-27: one mechanism for both gaps.** Both are "a locator reaches it, the tree does not". Alternatives: build our own tree from CDP `Accessibility.getFullAXTree` (complete, but a second outline format and a large diff), or patch the snapshot per gap (two code paths). Chosen: one extras pass, appended to the outline.
- **2026-10-27: `cursor: pointer` over hooking `addEventListener`.** A hook changes the page's own JavaScript, which sites can detect, and it must run before the page's scripts. The CSS check catches most script-only cards. Trade-off: it misses a handler with no pointer cursor.
- **2026-10-27: extras go last, not in place.** Their place in the tree is unknown. Twins are told apart by their own checked `nth`, so order does not matter for acting.
- **2026-10-27: iframes are not searched for extras.** The tree already covers iframes. Add it when a flow fails on one.
- **2026-10-27: canvas apps out of scope.** Pixel clicks break the "never press at a point" rule. Site APIs instead.
- **2026-10-27: overlay in the page, not CDP `Overlay.highlightNode`.** CDP highlights one node at a time and draws no text. A DOM layer shows 80 numbered boxes and a panel. Trade-off: a page script can see a node on `<html>`. The attribute name is random, and the layer only exists headed, where a person watches.
- **2026-10-27: boxes from the refs' hints, not from marks' layout order.** The numbers must match the prompt. Cost: one `boundingBox` per ref per step, in parallel, headed only.

- **2026-10-28: the panel is a TUI with a live trace, and takes clicks (William).** Every command adds a row (aim, ✓/✗, ms); a click opens its target and error. Wren dark tokens, purple accent. Options: (a) a trace page on the explore server, outside the browser: zero risk, but a second window; (b) clicks in the page. Picked (b). Its rules: a window capture listener swallows pointer events over the panel before the page and the observer; mousedown's default stops, so focus stays; the panel is inert while a command runs; each draw is capped at 1 s. Trade-off: a page's own window capture listener added before ours still sees a click on the panel. Rows never hold a typed value or a query string.
- **2026-10-28: panel resizes, rows say more, the busy line moves (William).** A corner grip sets width and trace height; the drag holds pointer capture, so the page sees no move. Rows sit on a subgrid (columns fit their content). Each row has a dim note: where the page went, controls added and gone, chars read. Never a value. The busy line cycles the hands' phases (locating, aiming, moving, clicking) by CSS `content` keyframes, so the page runs no timer of ours. Between commands, with a goal set, it says "thinking". The bar shows the run's seed.
- **2026-10-29: the panel is decorative (William).** Its body passes every click to the page; only the bar (move, buttons) and the grip take a pointer, swallowed before the page. Gone: the click-through toggle, the side-snap arrow, `[×]` beside `[_]`, opening a row (a failed row's note holds the error). New: drag anywhere, width and height, one minimize to a left-edge tab, a boxes toggle. Trade-off: the trace no longer scrolls (the panel takes no wheel); size it taller to see more rows.
- **2026-10-28: the journal keeps typing and a stepper's repeats (Airbnb and Amazon demos).** Two gaps lost steps at compile. (1) `type` was never journaled; now a `type` after a click on a control that still holds focus is journaled as `input` on that control. Otherwise the answer says it was not journaled. (2) The compiler collapsed a second click on one control as a retry; now a click on the last clicked control, after a command that changed the page's controls, is journaled `again` and kept. Alternative: journal every click and drop retries by error rows only. Rejected: a retry after a timeout leaves no error row when the second try wins. Demo flows: `airbnb-search` (place, dates, adults) and `amazon-cart` (search, department, quantity; reads the cart line, never checks out).
