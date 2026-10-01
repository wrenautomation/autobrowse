/**
 * Page text laid out the way it looks. `innerText` reads in DOM order, so a
 * label and its value in two flex children, a sidebar and the article beside
 * it, or a table's cells come out as unrelated lines. Here the page measures
 * every block of text it renders (a box per block, from its text's own
 * rectangles), and the boxes are cut apart by the whitespace between them
 * (XY-cut, as PDF readers do): a full-width gap stacks, a full-height gap puts
 * things side by side. Side-by-side one-liners read as one row (`Price | $40`);
 * side-by-side blocks read as columns (`[col 1/2]`, contents indented one
 * space). `coords` prefixes each line with the box's page position.
 */
import type { Page } from "playwright";

/** One rendered block of text, in page pixels. `lvl` is a heading's level. */
export interface Box {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
  lvl?: number;
}

export interface LayoutOptions {
  /** Prefix each line with `@x,y` (page pixels, top-left of its first box). */
  coords?: boolean;
  /** Longest row before side-by-side one-liners fall back to columns. */
  rowWidth?: number;
}

/** A gap narrower than this is not a column gutter: two words, an icon and its label. */
const MIN_SIDE_GAP = 8;
/** A gutter this wide down most of the group counts double against a vertical gap: two columns are never read across. */
const GUTTER = 24;
const SIDE_WEIGHT = 2;
/** Every gap on the chosen axis this close to the widest is cut too: a list splits in one go. */
const NEAR_WIDEST = 0.75;
/** Pixels two edges may differ by and still be level. */
const ROW_SLACK = 4;
const MAX_BOXES = 4000;

type Tree =
  | { kind: "leaf"; boxes: Box[] }
  | { kind: "stack"; parts: Tree[] }
  | { kind: "side"; parts: Tree[] };

interface Gap {
  /** Index in the sorted order where the next group starts. */
  at: number;
  size: number;
}

/** Gaps in the boxes' shadow on one axis: where nothing covers, a clean cut through them all. */
function gaps(sorted: Box[], lo: (b: Box) => number, hi: (b: Box) => number): Gap[] {
  const out: Gap[] = [];
  let reach = hi(sorted[0] as Box);
  for (let i = 1; i < sorted.length; i++) {
    const b = sorted[i] as Box;
    if (lo(b) > reach) out.push({ at: i, size: lo(b) - reach });
    reach = Math.max(reach, hi(b));
  }
  return out;
}

function split(sorted: Box[], cuts: Gap[]): Box[][] {
  const groups: Box[][] = [];
  let from = 0;
  for (const c of cuts) {
    groups.push(sorted.slice(from, c.at));
    from = c.at;
  }
  groups.push(sorted.slice(from));
  return groups;
}

/**
 * How much a gutter separates: its width, doubled when it is wide and both
 * sides run most of the group's height (a sidebar). A side that covers less
 * than half the height is no column while a vertical gap can cut first (a
 * `login` link alone at the top right belongs to the header's row).
 */
function gutterScores(byX: Box[], xs: Gap[], stackable: boolean): number[] {
  const top = Math.min(...byX.map((b) => b.y));
  const tall = Math.max(...byX.map((b) => b.y + b.h)) - top || 1;
  const span = (from: number, to: number) => {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let i = from; i < to; i++) {
      const b = byX[i] as Box;
      lo = Math.min(lo, b.y);
      hi = Math.max(hi, b.y + b.h);
    }
    return hi - lo;
  };
  return xs.map((g) => {
    const cover = Math.min(span(0, g.at), span(g.at, byX.length)) / tall;
    if (cover < 0.5) return stackable ? 0 : g.size;
    return g.size * (g.size >= GUTTER ? SIDE_WEIGHT : 1);
  });
}

/** Recursive XY-cut: the widest gap (gutters scored) decides the axis; boxes nothing separates are a leaf. */
export function cut(boxes: Box[]): Tree {
  if (boxes.length <= 1) return { kind: "leaf", boxes };
  const byY = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
  const byX = [...boxes].sort((a, b) => a.x - b.x || a.y - b.y);
  const ys = gaps(
    byY,
    (b) => b.y,
    (b) => b.y + b.h,
  );
  const xs = gaps(
    byX,
    (b) => b.x,
    (b) => b.x + b.w,
  ).filter((g) => g.size >= MIN_SIDE_GAP);
  const scores = gutterScores(byX, xs, ys.length > 0);
  const bestY = Math.max(0, ...ys.map((g) => g.size));
  const bestX = Math.max(0, ...scores);
  if (!bestY && !bestX) return { kind: "leaf", boxes: byY };
  // A tie stacks: chips wrapped onto rows read row by row.
  const side = bestX > bestY;
  const cuts = side
    ? xs.filter((_, i) => (scores[i] as number) >= bestX * NEAR_WIDEST)
    : ys.filter((g) => g.size >= bestY * NEAR_WIDEST);
  const parts = split(side ? byX : byY, cuts).map(cut);
  return { kind: side ? "side" : "stack", parts };
}

/**
 * Two boxes on one row: tops level (a table's cells), or middles level at a
 * like height (a label centred on its field). A paragraph beside a link that
 * happens to share its middle is not.
 */
const sameRow = (a: Box, b: Box) =>
  Math.abs(a.y - b.y) <= ROW_SLACK ||
  (Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) <= ROW_SLACK &&
    Math.max(a.h, b.h) <= 2 * Math.min(a.h, b.h));

/** Boxes grouped into lines top to bottom, each line left to right. */
function rowsOf(boxes: Box[]): Box[][] {
  const rows: Box[][] = [];
  for (const b of [...boxes].sort((a, c) => a.y - c.y || a.x - c.x)) {
    const row = rows.find((r) => sameRow(r[0] as Box, b));
    if (row) row.push(b);
    else rows.push([b]);
  }
  return rows.map((r) => r.sort((a, c) => a.x - c.x));
}

const leaves = (t: Tree): Box[] => (t.kind === "leaf" ? t.boxes : t.parts.flatMap(leaves));
/**
 * Columns whose boxes line up row by row are a table (a rank beside a title,
 * a label beside a value, wrapped chips): read across, one line per row. Not
 * a table when too few rows hold more than one column (a sidebar beside an
 * article).
 */
export function tableRows(parts: Tree[]): Box[][] | null {
  const cells = parts.flatMap((p, col) => leaves(p).map((b) => ({ b, col })));
  cells.sort((a, b) => a.b.y - b.b.y || a.b.x - b.b.x);
  const rows: Array<typeof cells> = [];
  for (const c of cells) {
    const row = rows.at(-1);
    if (row && sameRow(row[0]?.b as Box, c.b)) row.push(c);
    else rows.push([c]);
  }
  const across = rows.filter((r) => new Set(r.map((c) => c.col)).size > 1).length;
  if (across < 2 || across * 3 < rows.length) return null;
  return rows.map((r) => r.sort((a, b) => a.b.x - b.b.x).map((c) => c.b));
}

/** The tree as lines: rows of one-liners, tables read across, columns of blocks, everything else top to bottom. */
export function render(tree: Tree, o: LayoutOptions = {}): string[] {
  const rowWidth = o.rowWidth ?? 200;
  const at = (b: Box) => (o.coords ? `@${b.x},${b.y} ` : "");
  const line = (b: Box) => `${at(b)}${b.lvl ? `${"#".repeat(b.lvl)} ` : ""}${b.t}`;
  // Boxes with no gap to cut on that still share a line (`owner / repo`): one line, spaced as they sit.
  const joinRow = (row: Box[]) =>
    row
      .map((b, i) => {
        const prev = row[i - 1];
        const text = i ? line({ ...b, x: 0, y: 0 }).replace(/^@0,0 /, "") : line(b);
        return !prev ? text : `${b.x - (prev.x + prev.w) >= MIN_SIDE_GAP ? " | " : " "}${text}`;
      })
      .join("");
  const walk = (t: Tree): string[] => {
    if (t.kind === "leaf") return rowsOf(t.boxes).map(joinRow);
    const parts = t.parts.map(walk);
    if (t.kind === "stack") return parts.flat();
    const table = tableRows(t.parts);
    if (table) return table.map(joinRow);
    const ones = parts.every((p) => p.length === 1);
    if (ones) {
      // One line each: a row. Coordinates say where the row starts, once.
      const cells = parts.map((p) => (p[0] as string).replace(/^@\d+,\d+ /, ""));
      const row = cells.join(" | ");
      const first = parts[0]?.[0]?.match(/^@\d+,\d+ /)?.[0] ?? "";
      if (row.length <= rowWidth) return [`${first}${row}`];
    }
    return parts.flatMap((p, i) => [`[col ${i + 1}/${parts.length}]`, ...p.map((l) => ` ${l}`)]);
  };
  return walk(tree);
}

/** Boxes from the page: plain JS, it runs there. A block is the text of one non-inline element between its block children. */
const BOXES_SCRIPT = `(max) => {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "HEAD", "TITLE"]);
  const shown = new Map();
  const visible = (el) => {
    if (shown.has(el)) return shown.get(el);
    const r = el.getBoundingClientRect();
    const ok = r.width >= 2 && r.height >= 2 &&
      (!el.checkVisibility || el.checkVisibility({ visibilityProperty: true }));
    shown.set(el, ok);
    return ok;
  };
  const display = new Map();
  const owner = (el) => {
    let e = el;
    while (e && e !== document.body) {
      let d = display.get(e);
      if (d === undefined) { d = getComputedStyle(e).display; display.set(e, d); }
      if (!d.startsWith("inline") && d !== "contents") return e;
      e = e.parentElement;
    }
    return document.body;
  };
  const sx = window.scrollX, sy = window.scrollY;
  const groups = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n && groups.length < max; n = walker.nextNode()) {
    const text = n.nodeValue;
    if (!text) continue;
    const parent = n.parentElement;
    // Space between two inline elements: kept in the block it sits in, never a box of its own.
    if (!text.trim()) {
      const g = groups[groups.length - 1];
      if (g && parent && owner(parent) === g.o) g.t.push(" ");
      continue;
    }
    if (!parent || parent.closest("script,style,noscript,template,svg") || SKIP.has(parent.tagName)) continue;
    if (!visible(parent)) continue;
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const o = owner(parent);
    // Clipped to nothing by its block (a screen-reader-only heading): not on screen.
    if (o !== parent && !visible(o)) continue;
    let g = groups[groups.length - 1];
    if (!g || g.o !== o) {
      const h = o.closest("h1,h2,h3,h4,h5,h6");
      g = { o, t: [], l: r.left, t0: r.top, r: r.right, b: r.bottom, lvl: h ? Number(h.tagName[1]) : 0 };
      groups.push(g);
    }
    g.t.push(text);
    g.l = Math.min(g.l, r.left); g.t0 = Math.min(g.t0, r.top);
    g.r = Math.max(g.r, r.right); g.b = Math.max(g.b, r.bottom);
  }
  return groups.map((g) => {
    const box = {
      t: g.t.join("").replace(/\\s+/g, " ").trim(),
      x: Math.round(g.l + sx), y: Math.round(g.t0 + sy),
      w: Math.round(g.r - g.l), h: Math.round(g.b - g.t0),
    };
    if (g.lvl) box.lvl = g.lvl;
    return box;
  }).filter((b) => b.t && b.x + b.w > 0 && b.y + b.h > 0);
}`;

export async function pageBoxes(page: Page, max = MAX_BOXES): Promise<Box[]> {
  return page.evaluate<Box[]>(`(${BOXES_SCRIPT})(${max})`).catch(() => []);
}

/** Boxes → laid-out text. Pure, so a test needs no browser. */
export function layout(boxes: Box[], o: LayoutOptions = {}): string {
  return boxes.length ? render(cut(boxes), o).join("\n") : "";
}

/** The page's text as it looks, cut to `limit` characters. */
export async function layoutText(
  page: Page,
  limit: number,
  o: LayoutOptions = {},
): Promise<string> {
  return layout(await pageBoxes(page), o).slice(0, limit);
}
