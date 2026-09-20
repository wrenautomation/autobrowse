/**
 * The page as the model sees it: a short numbered list of what can be
 * acted on, plus headings and a little text for bearings. Built from
 * Playwright's aria snapshot, which is a YAML-ish tree of `- role "name"`
 * lines. A raw tree is mostly `generic` scaffolding and repeated text; the
 * digest keeps a page at a few hundred tokens and gives every actionable
 * element a ref number, so the model points instead of spelling hints
 * (fewer tokens out, no misspelled names). Refs resolve back to
 * role + exact name (+ nth among same-named twins), which is what the
 * recorder stores and the compiler renders.
 */
import type { Hints } from "../browser/locate.js";

const ACTIONABLE = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "slider",
  "spinbutton",
  "listbox",
]);
const CONTEXT = new Set(["heading", "dialog", "alertdialog", "alert", "status"]);

export interface Ref {
  n: number;
  role: string;
  name: string;
  /** Index among elements with the same role and name on this page. */
  nth: number;
  /** `[checked]`, `[disabled]`, `[expanded]`, `[level=2]` as the tree wrote them. */
  attrs: string;
}

export interface Digest {
  text: string;
  refs: Ref[];
}

export interface DigestOptions {
  /** Most refs to list; the rest of the page is summarised as a count. */
  maxRefs?: number;
  /** Most text lines to keep. */
  maxText?: number;
  /** Longest text line. */
  textWidth?: number;
}

/** One tree line: `- role "name" [attr] [attr=v]: tail` in any of its shapes. */
const LINE = /^\s*-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s+\[[^\]]*\])*)\s*(?::\s*(.*))?$/;

/** Lines with YAML-special characters come single-quoted: `- 'button "a: b"'`. */
function unwrap(line: string): string {
  const m = line.match(/^(\s*-\s+)'(.*)'(:?)\s*$/);
  return m ? `${m[1]}${(m[2] as string).replace(/''/g, "'")}${m[3]}` : line;
}

function unquote(s: string): string {
  return s.replace(/\\(["\\])/g, "$1");
}

/** Shrink the aria snapshot to a numbered digest. */
export function digest(aria: string, o: DigestOptions = {}): Digest {
  const maxRefs = o.maxRefs ?? 80;
  const maxText = o.maxText ?? 20;
  const width = o.textWidth ?? 100;
  const refs: Ref[] = [];
  const lines: string[] = [];
  const seenText = new Set<string>();
  const twins = new Map<string, number>();
  let textLines = 0;
  let hiddenRefs = 0;
  for (const raw of aria.split("\n")) {
    const m = unwrap(raw).match(LINE);
    if (!m) continue;
    const [, role = "", quoted, attrs = "", tail] = m;
    const name = quoted === undefined ? "" : unquote(quoted);
    if (ACTIONABLE.has(role)) {
      if (refs.length >= maxRefs) {
        hiddenRefs++;
        continue;
      }
      const key = `${role}\u0000${name}`;
      const nth = twins.get(key) ?? 0;
      twins.set(key, nth + 1);
      const n = refs.length + 1;
      refs.push({ n, role, name, nth, attrs: attrs.trim() });
      lines.push(`[${n}] ${role}${name ? ` "${name}"` : ""}${attrs ? ` ${attrs.trim()}` : ""}`);
      continue;
    }
    if (CONTEXT.has(role) || role === "cell") {
      const body = clip(name || tail || "", width);
      if (!body) continue;
      if (refs.length >= maxRefs) {
        hiddenRefs++;
        continue;
      }
      const key = `${role}\u0000${body}`;
      const nth = twins.get(key) ?? 0;
      twins.set(key, nth + 1);
      const n = refs.length + 1;
      refs.push({ n, role, name: body, nth, attrs: attrs.trim() });
      lines.push(`[${n}] ${role}${attrs ? ` ${attrs.trim()}` : ""}: ${body}`);
      continue;
    }
    if (role === "text" || role === "paragraph") {
      const body = clip(tail ?? name, width);
      if (!body || seenText.has(body) || textLines >= maxText) continue;
      seenText.add(body);
      textLines++;
      lines.push(`  ${body}`);
    }
  }
  if (hiddenRefs) lines.push(`(+${hiddenRefs} more controls below; scroll or narrow the goal)`);
  return { text: lines.join("\n"), refs };
}

function clip(s: string, width: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > width ? `${t.slice(0, width - 1)}…` : t;
}

/** Hints that find the ref'd element again, in the recorder's vocabulary. */
export function hintsFor(ref: Ref): Hints {
  const h: Hints = { role: ref.role };
  if (ref.name) h.name = ref.name;
  if (ref.nth) h.nth = ref.nth;
  return h;
}

const REF_LINE = /^\[(\d+)\] /;

/**
 * The page as the model should see it after the previous step: the whole
 * digest when controls moved, else only what changed. Refs keep their
 * numbers only when every `[n]` line is the same as before, so that is
 * the condition for a delta; unchanged pages cost a line.
 */
export function pageForModel(prev: Digest | null, next: Digest): string {
  if (!prev) return next.text;
  if (prev.text === next.text) return "(unchanged since the last step; the same refs apply)";
  const before = prev.text.split("\n");
  const after = next.text.split("\n");
  const refsBefore = before.filter((l) => REF_LINE.test(l));
  const refsAfter = after.filter((l) => REF_LINE.test(l));
  const sameRefs =
    refsBefore.length === refsAfter.length && refsBefore.every((l, i) => l === refsAfter[i]);
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
