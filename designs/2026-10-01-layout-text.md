# Layout-aware page text

2026-10-01. Status: built.

## Ask

William: scrape pages keeping their visual organization (text grouped by
position, or coordinates) for better signal, with marginal token cost.

## What was there

- Explore `text`: `document.body.innerText`. DOM order: a label and its
  value in two flex children, a sidebar beside an article, a rank beside
  its title come out as unrelated lines.
- `read` (no browser): HTML regex-stripped; table cells ran together.
- The agent reads the aria digest (semantic, not visual). Unchanged.

## Shape

`src/browser/layout.ts`:

1. In the page, every non-inline element's own text (between its block
   children) is one box, measured from its text nodes' rectangles.
   Hidden and clipped-to-nothing blocks are skipped; opacity 0 is kept
   (scroll-reveal content is real content, `innerText` keeps it too).
2. In Node, recursive XY-cut: a gap in the boxes' shadow on one axis cuts
   them all. The widest gap picks the axis. A gutter ≥ 24px down most of
   the group counts double; a side covering under half the height is no
   column while a vertical gap exists. Ties stack.
3. Render: side-by-side one-liners are a row (`a | b`); columns whose
   boxes have level tops (or level middles at a like height) in at least a
   third of rows are a table, read across; otherwise `[col i/n]` with one
   space of indent. Headings keep `#` marks. `coords` puts `@x,y` first.

Explore `text` uses it by default; `layout: false` gives `innerText`.
`read` now writes table rows across (`Plan | Price`).

## Tokens (5 public pages, 1280×900, Anthropic tokenizer)

| Page | innerText | layout | layout + coords |
|---|---|---|---|
| wren lander | 2,912 | 2,759 | 3,632 |
| Hacker News | 1,305 | 1,207 | 1,470 |
| GitHub repo | 2,983 | 2,752 | 3,536 |
| Wikipedia article | 6,542 | 6,519 | 7,334 |
| npm (bot page) | 64 | 63 | 84 |

Layout is 0–8% smaller (rows join items innerText puts on lines of their
own). Coords add 12–32%, so they are opt-in. In-page measure: 5–40 ms.

## Decisions

| # | Decision | Why |
|---|---|---|
| L1 | Boxes per block, not per text node or per line | A paragraph is one unit to read; per-line boxes cost coords for nothing |
| L2 | XY-cut, not a grid or clustering | No tuning per site; every cut is through whitespace, never through text |
| L3 | Gutter scored by width × coverage | A lone `login` at the header's right end otherwise split the whole page into columns (HN) |
| L4 | Row = level tops, or level middles at a like height | Middles alone paired a long paragraph with a sidebar link |
| L5 | Default on for explore `text`; flows' `FlowPage.text()` stays `innerText` | Flows parse that text with patterns; changing it under them breaks them |
| L6 | Coords opt-in | +12–32% tokens; worth it only when position itself is the question |

## Not done

- The agent digest (aria) has no positions. If twin controls confuse it,
  a coarse region tag per ref is the next step.
- Shadow DOM and iframes are skipped, as `innerText` skips them.
- Charts read as scattered axis labels (as they do in `innerText`).
