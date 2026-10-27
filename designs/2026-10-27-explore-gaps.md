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

See the decision log entry for 10-27 and `src/explore/overlay.ts`.

## Decision log

- **2026-10-27: one mechanism for both gaps.** Both are "a locator reaches it, the tree does not". Alternatives: build our own tree from CDP `Accessibility.getFullAXTree` (complete, but a second outline format and a large diff), or patch the snapshot per gap (two code paths). Chosen: one extras pass, appended to the outline.
- **2026-10-27: `cursor: pointer` over hooking `addEventListener`.** A hook changes the page's own JavaScript, which sites can detect, and it must run before the page's scripts. The CSS check catches most script-only cards. Trade-off: it misses a handler with no pointer cursor.
- **2026-10-27: extras go last, not in place.** Their place in the tree is unknown. Twins are told apart by their own checked `nth`, so order does not matter for acting.
- **2026-10-27: iframes are not searched for extras.** The tree already covers iframes. Add it when a flow fails on one.
- **2026-10-27: canvas apps out of scope.** Pixel clicks break the "never press at a point" rule. Site APIs instead.
