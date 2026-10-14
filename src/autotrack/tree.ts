/**
 * Accessibility trees as the steps view reads them (autotrack design doc, "Derived offline"):
 * a window's `trees/<n>.json` or a web page's outline `trees/<n>.txt`, boiled down to the nodes
 * that have a name, and the difference between two of them (added, removed, renamed by role + name).
 */

export interface TreeNode {
  role: string;
  name: string;
  /** AXIdentifier / UIA AutomationId. */
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/** A tree is never read past this many nodes: a runaway page must not own the memory. */
export const MAX_TREE_NODES = 20_000;
/** A diff lists at most this many nodes of each kind; `counts` has the full numbers. */
export const DIFF_LIST_CAP = 40;

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

function nodeOf(raw: Record<string, unknown>): TreeNode | undefined {
  const role = typeof raw.role === "string" ? raw.role : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return undefined;
  const x = num(raw.x);
  const y = num(raw.y);
  const width = num(raw.width);
  const height = num(raw.height);
  return {
    role,
    name,
    ...(typeof raw.id === "string" && raw.id ? { id: raw.id } : {}),
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

/** Pre-order walk of a nested `{role, name, children}` tree, iterative so depth cannot overflow. */
function walk(root: unknown, out: TreeNode[]): void {
  const stack: unknown[] = [root];
  while (stack.length && out.length < MAX_TREE_NODES) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    const raw = cur as Record<string, unknown>;
    const n = nodeOf(raw);
    if (n) out.push(n);
    const kids = raw.children;
    if (Array.isArray(kids)) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
}

// `- link "Docs" [level=2]:` / `button "Save"` / `  - text: hello` (a Playwright-style outline).
const OUTLINE_LINE = /^\s*(?:-\s+)?([A-Za-z][\w-]*)\s+"((?:[^"\\]|\\.)*)"/;

/** The named nodes of a tree file. Unreadable text gives no nodes, not an error. */
export function parseTree(body: string, ext: "json" | "txt"): TreeNode[] {
  const out: TreeNode[] = [];
  if (ext === "txt") {
    for (const line of body.split("\n")) {
      const m = OUTLINE_LINE.exec(line);
      const name = m?.[2]?.replace(/\\(.)/g, "$1").trim();
      if (m?.[1] && name) out.push({ role: m[1], name });
      if (out.length >= MAX_TREE_NODES) break;
    }
    return out;
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return out;
  }
  if (json && typeof json === "object" && Array.isArray((json as { nodes?: unknown }).nodes)) {
    for (const raw of (json as { nodes: unknown[] }).nodes) {
      if (raw && typeof raw === "object") {
        const n = nodeOf(raw as Record<string, unknown>);
        if (n) out.push(n);
      }
      if (out.length >= MAX_TREE_NODES) break;
    }
    return out;
  }
  walk(json, out);
  return out;
}

export interface TreeDiff {
  added: { role: string; name: string }[];
  removed: { role: string; name: string }[];
  /** Same role at the same id or rectangle, a different name. */
  renamed: { role: string; from: string; to: string }[];
  /** The full numbers, when the lists above were cut. */
  counts: { added: number; removed: number; renamed: number };
}

const keyOf = (n: TreeNode) => `${n.role}\u0000${n.name}`;
const rectOf = (n: TreeNode) =>
  n.x === undefined || n.y === undefined || n.width === undefined || n.height === undefined
    ? undefined
    : `${n.role}\u0000r${Math.round(n.x)},${Math.round(n.y)},${Math.round(n.width)},${Math.round(n.height)}`;
const idOf = (n: TreeNode) => (n.id ? `${n.role}\u0000i${n.id}` : undefined);

/** What is in `a` and not `b`, counting repeats: two "OK" buttons then one leaves one. */
function surplus(a: readonly TreeNode[], b: readonly TreeNode[]): TreeNode[] {
  const have = new Map<string, number>();
  for (const n of b) have.set(keyOf(n), (have.get(keyOf(n)) ?? 0) + 1);
  const out: TreeNode[] = [];
  for (const n of a) {
    const left = have.get(keyOf(n)) ?? 0;
    if (left > 0) have.set(keyOf(n), left - 1);
    else out.push(n);
  }
  return out;
}

/** Nodes added, removed and renamed between two trees (role + name; a node with no name is noise). */
export function diffTrees(before: readonly TreeNode[], after: readonly TreeNode[]): TreeDiff {
  const removed = surplus(before, after);
  const added = surplus(after, before);
  // A rename keeps its identity (an id, else its rectangle) and changes its name.
  const addedBy = new Map<string, TreeNode[]>();
  for (const n of added)
    for (const k of [idOf(n), rectOf(n)]) {
      if (!k) continue;
      const list = addedBy.get(k);
      if (list) list.push(n);
      else addedBy.set(k, [n]);
    }
  const renamed: TreeDiff["renamed"] = [];
  const goneRemoved = new Set<TreeNode>();
  const goneAdded = new Set<TreeNode>();
  for (const r of removed) {
    for (const k of [idOf(r), rectOf(r)]) {
      const to = k ? addedBy.get(k)?.find((n) => !goneAdded.has(n)) : undefined;
      if (!to) continue;
      renamed.push({ role: r.role, from: r.name, to: to.name });
      goneRemoved.add(r);
      goneAdded.add(to);
      break;
    }
  }
  const plain = (n: TreeNode) => ({ role: n.role, name: n.name });
  const addedLeft = added.filter((n) => !goneAdded.has(n));
  const removedLeft = removed.filter((n) => !goneRemoved.has(n));
  return {
    added: addedLeft.slice(0, DIFF_LIST_CAP).map(plain),
    removed: removedLeft.slice(0, DIFF_LIST_CAP).map(plain),
    renamed: renamed.slice(0, DIFF_LIST_CAP),
    counts: { added: addedLeft.length, removed: removedLeft.length, renamed: renamed.length },
  };
}
