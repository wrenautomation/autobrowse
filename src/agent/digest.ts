/**
 * The page as the model sees it: an outline of what can be acted on or
 * read, kept small. Built from Playwright's aria snapshot (a YAML-ish
 * tree of `- role "name"` lines). The outline keeps the tree's shape only
 * where it means something (a dialog, a form, a list, a table, a named
 * region), flattens `generic` scaffolding, joins a run of leaves onto one
 * line, folds a long run of look-alike rows, and gives every actionable
 * element a ref number so the model points instead of spelling hints.
 * Refs resolve back to role + exact name (+ nth among same-named twins),
 * which is what the recorder stores and the compiler renders.
 *
 * Wire form, one ref: `[n]B Save` — a code for the role, then the name,
 * then state marks (✓ checked, ✗ disabled, ▾ expanded, • selected).
 * Containers are `role "name":` with children indented one space.
 */
import { frameOfSection } from "../browser/frames.js";
import type { Hints } from "../browser/locate.js";

/** Actionable roles and their one-letter codes in the outline. */
export const CODES: Record<string, string> = {
  link: "L",
  button: "B",
  textbox: "T",
  searchbox: "T",
  combobox: "X",
  checkbox: "C",
  radio: "R",
  switch: "S",
  tab: "TAB",
  menuitem: "M",
  menuitemcheckbox: "M",
  menuitemradio: "M",
  option: "O",
  slider: "SL",
  spinbutton: "N",
  listbox: "LB",
  treeitem: "TI",
};
/** The legend, for the system prompt. */
export const LEGEND =
  "[n] refs: L link, B button, T text field, X combobox, C checkbox, R radio, S switch, TAB tab, M menu item, O option, SL slider, N number field, LB listbox, TI tree item, H1-H6 heading, cell table cell; marks: ✓ checked, ✗ disabled, ▾ expanded, • selected";

const CONTEXT = new Set(["alert", "status"]);
/** Table cells read as text; the controls inside them get the refs. */
const CELLS = new Set(["cell", "columnheader", "rowheader", "gridcell"]);
/** Containers whose shape is kept: shown as `role "name":` with children beneath. */
const STRUCTURE = new Set([
  "dialog",
  "alertdialog",
  "form",
  "region",
  "navigation",
  "main",
  "banner",
  "contentinfo",
  "complementary",
  "search",
  "list",
  "listitem",
  "table",
  "grid",
  "treegrid",
  "rowgroup",
  "row",
  "group",
  "radiogroup",
  "article",
  "tablist",
  "tabpanel",
  "menu",
  "menubar",
  "tree",
  "toolbar",
  "figure",
  "blockquote",
]);
/** Unnamed containers that read as one line when their children are leaves. */
const INLINE = new Set(["listitem", "row", "group", "article", "figure", "blockquote"]);
/** Unnamed containers that add no meaning of their own once their rows are inline. */
const TRANSPARENT = new Set(["list", "table", "grid", "rowgroup", "treegrid", "tree", "menu"]);
const REF = /\[\d+\][A-Z]*/;
const MARKS: Record<string, string> = {
  checked: "✓",
  disabled: "✗",
  expanded: "▾",
  selected: "•",
  pressed: "✓",
};

export interface Ref {
  n: number;
  role: string;
  name: string;
  /** Index among elements with the same role and name on this page. */
  nth: number;
  /** `[checked]`, `[disabled]`, `[expanded]`, `[level=2]` as the tree wrote them. */
  attrs: string;
  /** Inside an iframe: its selector chain from the page (`ariaWithFrames`). */
  frame?: string;
}

export interface Digest {
  text: string;
  refs: Ref[];
}

export interface DigestOptions {
  /** Most refs to list; the rest of the page is summarised as a count. */
  maxRefs?: number;
  /** Most free text lines to keep. */
  maxText?: number;
  /** Longest line. */
  textWidth?: number;
  /** A run of look-alike siblings longer than this is folded after this many. */
  maxRepeat?: number;
}

interface Node {
  role: string;
  name: string;
  attrs: string;
  tail: string;
  placeholder: string;
  children: Node[];
}

/** One tree line: `- role "name" [attr] [attr=v]: tail` in any of its shapes. */
const LINE = /^(\s*)-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s+\[[^\]]*\])*)\s*(?::\s*(.*))?$/;
const PROP = /^(\s*)-\s+\/(url|placeholder|description):\s*(.*)$/;

/** Lines with YAML-special characters come single-quoted: `- 'button "a: b"'`. */
function unwrap(line: string): string {
  const m = line.match(/^(\s*-\s+)'(.*)'(:?)\s*$/);
  return m ? `${m[1]}${(m[2] as string).replace(/''/g, "'")}${m[3]}` : line;
}
const unquote = (s: string) => s.replace(/\\(["\\])/g, "$1");
/** A tail with YAML-special characters comes double-quoted: `- text: "a: b"`. */
const unquoteTail = (s: string) => (/^".*"$/.test(s) ? unquote(s.slice(1, -1)) : s);

/** The snapshot as a tree; indentation is the nesting. */
export function parseAria(aria: string): Node[] {
  const root: Node = { role: "", name: "", attrs: "", tail: "", placeholder: "", children: [] };
  const stack: Array<{ depth: number; node: Node }> = [{ depth: -1, node: root }];
  for (const raw of aria.split("\n")) {
    const prop = raw.match(PROP);
    if (prop) {
      const depth = (prop[1] as string).length;
      let owner: Node | undefined;
      for (let i = stack.length - 1; i >= 0; i--) {
        const s = stack[i] as { depth: number; node: Node };
        if (s.depth < depth) {
          owner = s.node;
          break;
        }
      }
      if (owner && prop[2] === "placeholder") owner.placeholder = prop[3] as string;
      continue;
    }
    const m = unwrap(raw).match(LINE);
    if (!m) continue;
    const [, indent = "", role = "", quoted, attrs = "", tail = ""] = m;
    const depth = indent.length;
    const node: Node = {
      role,
      name: quoted === undefined ? "" : unquote(quoted),
      attrs: attrs.trim(),
      tail: unquoteTail(tail.trim()),
      placeholder: "",
      children: [],
    };
    while ((stack.at(-1) as { depth: number }).depth >= depth) stack.pop();
    (stack.at(-1) as { node: Node }).node.children.push(node);
    stack.push({ depth, node });
  }
  return root.children;
}

const clip = (s: string, width: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > width ? `${t.slice(0, width - 1)}…` : t;
};

/** Text a node carries itself: its tail, or its name for text-like roles. */
const ownText = (n: Node) => n.tail || (n.role === "text" || n.role === "paragraph" ? n.name : "");

/** All text under a node, for a nameless link or button whose label is a child. */
function deepText(n: Node): string {
  const parts: string[] = [];
  const walk = (x: Node) => {
    const t = ownText(x) || (x.role === "img" ? x.name : "");
    if (t) parts.push(t);
    for (const c of x.children) walk(c);
  };
  for (const c of n.children) walk(c);
  return parts.join(" ");
}

const marks = (attrs: string) =>
  [...attrs.matchAll(/\[([a-z]+)(?:=[^\]]*)?\]/g)].map((m) => MARKS[m[1] as string] ?? "").join("");
const level = (attrs: string) => attrs.match(/\[level=(\d)\]/)?.[1] ?? "";

/** A subtree's shape without its words: what makes two rows look alike (roles two levels down, order-free). */
function shape(n: Node): string {
  const kinds = new Set<string>();
  for (const c of n.children) {
    kinds.add(c.role);
    for (const g of c.children) kinds.add(`${c.role}/${g.role}`);
  }
  return `${n.role}(${[...kinds].sort().join(",")})`;
}

/** Shrink the aria snapshot to an outline with numbered refs. */
export function digest(aria: string, o: DigestOptions = {}): Digest {
  const maxRefs = o.maxRefs ?? 80;
  const maxText = o.maxText ?? 20;
  const width = o.textWidth ?? 120;
  const maxRepeat = o.maxRepeat ?? 8;
  const refs: Ref[] = [];
  const twins = new Map<string, number>();
  const seenText = new Set<string>();
  let textLines = 0;
  let hiddenRefs = 0;
  /** The iframe section being emitted, if any: its refs are found through it. */
  let frame: string | null = null;

  const ref = (role: string, name: string, attrs: string): Ref | null => {
    if (refs.length >= maxRefs) {
      hiddenRefs++;
      return null;
    }
    const key = `${frame ?? ""}\u0000${role}\u0000${name}`;
    const nth = twins.get(key) ?? 0;
    twins.set(key, nth + 1);
    const r: Ref = { n: refs.length + 1, role, name, nth, attrs, ...(frame ? { frame } : {}) };
    refs.push(r);
    return r;
  };

  /** One node → its pieces: `leaf` strings that may share a line, or `block` lines that stand alone. */
  type Piece = { kind: "leaf"; text: string } | { kind: "block"; lines: string[] };

  const emit = (n: Node, depth: number): Piece[] => {
    const section = depth === 0 && n.role === "iframe" ? frameOfSection(n.name) : null;
    if (section) {
      // An iframe's own section (a captcha, an embedded sign-in): shown as `iframe:`, refs carry the chain.
      frame = section;
      const kids = fold(n.children, 1);
      frame = null;
      return kids.length
        ? [{ kind: "block", lines: ["iframe:", ...pack(kids, width - 1).map((l) => ` ${l}`)] }]
        : [];
    }
    const code = CODES[n.role];
    if (code) {
      const name = n.name || clip(deepText(n), 60) || n.placeholder;
      // A control with no name at all cannot be found again by role and name; it is not offered.
      if (!name) return [];
      const r = ref(n.role, n.name, n.attrs);
      if (!r) return [];
      const ph = !n.name && n.placeholder ? "" : n.placeholder ? ` (${n.placeholder})` : "";
      return [{ kind: "leaf", text: `[${r.n}]${code} ${clip(name, 80)}${ph}${marks(n.attrs)}` }];
    }
    if (n.role === "heading") {
      const body = clip(n.name || n.tail || deepText(n), width);
      if (!body) return [];
      const r = ref(n.role, body, n.attrs);
      if (!r) return [];
      const lvl = level(n.attrs);
      const text = `[${r.n}]H${lvl} ${body}`;
      // Page headings stand alone; a card's or row's own heading reads inline with its row.
      return lvl && Number(lvl) >= 3
        ? [{ kind: "leaf", text }]
        : [{ kind: "block", lines: [text] }];
    }
    if (CONTEXT.has(n.role)) {
      const body = clip(n.name || n.tail || deepText(n), width);
      if (!body) return [];
      const r = ref(n.role, body, n.attrs);
      if (!r) return [];
      return [{ kind: "leaf", text: `[${r.n}]${n.role === "cell" ? "" : `${n.role} `}${body}` }];
    }
    if (CELLS.has(n.role)) {
      // The cell's name is its contents; when it has children they say it, with their refs.
      if (n.children.length) return n.children.flatMap((c) => emit(c, depth));
      const own = clip(n.name || n.tail, width);
      return own ? [{ kind: "leaf", text: own }] : [];
    }
    if (n.role === "text" || n.role === "paragraph") {
      const body = clip(ownText(n) || n.name, width);
      const kids = n.children.flatMap((c) => emit(c, depth));
      if (!body || seenText.has(body) || textLines >= maxText) return kids;
      seenText.add(body);
      textLines++;
      return [{ kind: "leaf", text: body }, ...kids];
    }
    if (n.role === "img") return n.name ? [{ kind: "leaf", text: `img ${clip(n.name, 40)}` }] : [];
    // A container: its children, folded when they repeat, joined when they are all leaves.
    const kids = dedupeLabels(fold(n.children, depth + (STRUCTURE.has(n.role) ? 1 : 0)));
    if (!kids.length) return [];
    // A row or item named after its own contents (a copy of them) is unnamed for our purposes.
    const plain = kids
      .flatMap((k) => (k.kind === "leaf" ? [k.text] : k.lines))
      .map((t) => t.replace(/\[\d+\][A-Z]*\d? /g, ""))
      .join(" ")
      .replace(/ · /g, " ");
    const echoed = n.name ? plain.startsWith(n.name.replace(/…$/, "").slice(0, 40)) : false;
    if (!n.name || echoed) {
      if (!STRUCTURE.has(n.role)) return kids;
      const leaves = kids.every((k) => k.kind === "leaf");
      // An unnamed row or item of leaves is one line: `[4]L Title · 3 comments`; one of a single leaf is that leaf.
      if (leaves && INLINE.has(n.role)) {
        if (kids.length === 1) return kids;
        const text = kids.map((k) => (k as { text: string }).text).join(" · ");
        if (text.length <= width) return [{ kind: "block", lines: [text] }];
      }
      // An unnamed list or table adds nothing but a line: its rows speak for it.
      if (TRANSPARENT.has(n.role)) return kids;
    }
    const head = `${n.role}${n.name ? ` "${clip(n.name, 60)}"` : ""}:`;
    const inner = pack(kids, width - depth - 1);
    return [{ kind: "block", lines: [head, ...inner.map((l) => ` ${l}`)] }];
  };

  /** Children in order; a long run of look-alikes keeps the first few and says how many follow. */
  const fold = (children: Node[], depth: number): Piece[] => {
    const out: Piece[] = [];
    let i = 0;
    while (i < children.length) {
      const sig = shape(children[i] as Node);
      let j = i + 1;
      while (j < children.length && shape(children[j] as Node) === sig) j++;
      const run = children.slice(i, j);
      const shown = run.length > maxRepeat + 1 ? run.slice(0, maxRepeat) : run;
      for (const c of shown) out.push(...emit(c, depth));
      if (shown.length < run.length) {
        // The rest keep their refs but show only their lead: the first ref'd thing in each.
        const leads: Piece[] = [];
        for (const c of run.slice(shown.length)) {
          const pieces = emit(c, depth);
          const lead = pieces
            .flatMap((p) => (p.kind === "leaf" ? [p.text] : p.lines))
            .find((t) => REF.test(t));
          if (lead) leads.push({ kind: "leaf", text: clip(lead, 60) });
        }
        out.push({
          kind: "block",
          lines: [`(+${run.length - shown.length} more like these${leads.length ? ":" : ""})`],
        });
        out.push(...leads);
      }
      i = j;
    }
    return out;
  };

  /** A radio's or checkbox's label often sits beside it as text: the control's name already says it. */
  const dedupeLabels = (pieces: Piece[]): Piece[] => {
    const names = new Set(
      pieces.flatMap((p) =>
        p.kind === "leaf" && REF.test(p.text)
          ? [p.text.replace(/^\[\d+\][A-Z]*\d? /, "").replace(/[✓✗▾•]+$/, "")]
          : [],
      ),
    );
    return pieces.filter((p) => !(p.kind === "leaf" && !REF.test(p.text) && names.has(p.text)));
  };

  /** Leaves share lines up to the width; blocks stand on their own. */
  const pack = (pieces: Piece[], w: number): string[] => {
    const lines: string[] = [];
    let cur = "";
    const flush = () => {
      if (cur) lines.push(cur);
      cur = "";
    };
    for (const p of pieces) {
      if (p.kind === "block") {
        flush();
        lines.push(...p.lines);
        continue;
      }
      if (!cur) cur = p.text;
      else if (cur.length + 3 + p.text.length <= w) cur += ` · ${p.text}`;
      else {
        flush();
        cur = p.text;
      }
    }
    flush();
    return lines;
  };

  const lines = pack(fold(parseAria(aria), 0), width);
  if (hiddenRefs) lines.push(`(+${hiddenRefs} more controls below; scroll or narrow the goal)`);
  return { text: lines.join("\n"), refs };
}

/** Hints that find the ref'd element again, in the recorder's vocabulary. */
export function hintsFor(ref: Ref): Hints {
  const h: Hints = { role: ref.role };
  if (ref.name) h.name = ref.name;
  if (ref.nth) h.nth = ref.nth;
  if (ref.frame) h.frame = ref.frame;
  return h;
}

/**
 * The page as a delta from the previous step: the whole outline when
 * controls moved, else only what changed. Not what the agent sends (a model
 * with no memory between calls needs the whole outline every step); kept
 * for a caller that holds a conversation.
 */
export function pageForModel(prev: Digest | null, next: Digest): string {
  if (!prev) return next.text;
  if (prev.text === next.text) return "(unchanged since the last step; the same refs apply)";
  const before = prev.text.split("\n");
  const after = next.text.split("\n");
  const sameRefs =
    prev.refs.length === next.refs.length &&
    prev.refs.every((r, i) => {
      const o = next.refs[i] as Ref;
      return r.role === o.role && r.name === o.name;
    });
  if (!sameRefs) return next.text;
  const was = new Set(before);
  const now = new Set(after);
  const delta = [
    ...after.filter((l) => !was.has(l)).map((l) => `+ ${l.trim()}`),
    ...before.filter((l) => !now.has(l)).map((l) => `- ${l.trim()}`),
  ];
  if (delta.length >= after.length) return next.text;
  return `(same controls as the last step; the same refs apply; text that changed:)\n${delta.join("\n")}`;
}
