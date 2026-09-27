/**
 * Mending a compiled workflow in place: the one op that broke, changed in
 * the outline and in the module's source, and nothing else. The model's
 * finish (plan inputs, gates, proof reads) stays as it was, so a mend costs
 * no re-render and no model. When the source no longer shows the op the way
 * the outline renders it (the finish reshaped it), the source comes back
 * null and the caller re-renders instead.
 */
import type { Hints } from "../browser/locate.js";
import type { Outline, OutlineOp } from "./outline.js";
import { flowInputs, renderOp } from "./render.js";

type BrowserStep = Extract<Outline["steps"][number], { kind: "browser" }>;

/** Hints as rendered source holds them: empty keys dropped, key order ignored. */
const canon = (h: Hints) =>
  JSON.stringify(
    Object.entries(h)
      .filter(([, v]) => v)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
export const sameHints = (a: Hints, b: Hints) => canon(a) === canon(b);

/**
 * Which op of a step broke: the one whose hints the run was looking for,
 * then by goal, then (the same act twice, "click Next" on two pages) by how
 * many acts and reads the run made before it.
 */
export function brokenOp(
  step: BrowserStep,
  hints: Hints | undefined,
  goal: string | null,
  actsBefore?: number,
): number | null {
  if (!hints) return null;
  const found = step.ops.flatMap((op, i) =>
    op.kind !== "human" && sameHints(op.hints, hints) ? [i] : [],
  );
  const byGoal = found.filter((i) => {
    const op = step.ops[i];
    return op?.kind !== "human" && op?.goal === goal;
  });
  const pool = byGoal.length ? byGoal : found;
  if (pool.length === 1) return pool[0] as number;
  if (actsBefore === undefined) return null;
  // Acts and reads before op i: one pass, not a recount per candidate.
  const rank: number[] = [];
  let n = 0;
  for (const op of step.ops) {
    rank.push(n);
    if (op.kind !== "human") n += 1;
  }
  return pool.find((i) => rank[i] === actsBefore) ?? null;
}

export interface Mended {
  outline: Outline;
  /** The module with only that op's statement changed; null = re-render. */
  source: string | null;
}

/** Swap one op's hints: a kept locator fix written into the workflow. */
export function swapHints(
  outline: Outline,
  source: string,
  stepIndex: number,
  opIndex: number,
  hints: Hints,
): Mended {
  const op = browserStep(outline, stepIndex).ops[opIndex];
  if (!op || op.kind === "human") throw new Error(`step ${stepIndex} has no op ${opIndex}`);
  return replaceOp(outline, source, stepIndex, opIndex, { ops: [{ ...op, hints }] });
}

/** Replace one op with what a repair did (one op or a few); the rest of the step is untouched. */
export function replaceOp(
  outline: Outline,
  source: string,
  stepIndex: number,
  opIndex: number,
  healed: (Pick<Outline, "fields" | "secrets"> & { ops: OutlineOp[] }) | { ops: OutlineOp[] },
): Mended {
  const step = browserStep(outline, stepIndex);
  const old = step.ops[opIndex];
  if (!old) throw new Error(`step ${step.name} has no op ${opIndex}`);
  if (healed.ops.length === 0) throw new Error("the repair did nothing the flow could replay");
  const ops = [...step.ops.slice(0, opIndex), ...healed.ops, ...step.ops.slice(opIndex + 1)];
  const next: Outline = {
    ...outline,
    steps: outline.steps.map((s, i) => (i === stepIndex ? { ...step, ops } : s)),
    ...("fields" in healed
      ? {
          // Values the repair typed join the plan.
          fields: dedupe([...outline.fields, ...healed.fields], (f) => f.key),
          secrets: dedupe([...outline.secrets, ...healed.secrets], (s) => s.key),
        }
      : {}),
  };
  // A new plan field or secret changes the step's input type: that is a re-render.
  const before = flowInputs(step);
  const after = flowInputs({ ...step, ops });
  const grew =
    after.fields.some((f) => !before.fields.includes(f)) ||
    after.secrets.some((k) => !before.secrets.includes(k));
  const at = grew ? null : statementOf(source, outline, stepIndex, opIndex);
  if (!at) return { outline: next, source: null };
  const body = healed.ops.map((op) => renderOp(op).trim()).join(`\n${at.indent}`);
  return { outline: next, source: source.slice(0, at.start) + body + source.slice(at.end) };
}

function browserStep(outline: Outline, i: number): BrowserStep {
  const step = outline.steps[i];
  if (step?.kind !== "browser") throw new Error("only a browser step can be mended");
  return step;
}

function dedupe<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((t) => {
    if (seen.has(key(t))) return false;
    seen.add(key(t));
    return true;
  });
}

/** Whitespace and trailing commas ignored: the formatter wraps long calls. */
const norm = (s: string) => s.replace(/\s+/g, "").replace(/,([}\])])/g, "$1");

interface Span {
  start: number;
  end: number;
  indent: string;
  /** The statement without its trailing comment, normalised. */
  text: string;
}

/** Every `fp.act(` / `fp.read(` statement in the source, in order. */
function statements(src: string): Span[] {
  const out: Span[] = [];
  for (const m of src.matchAll(/\bfp\.(?:act|read)\(/g)) {
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    const indent = /^[ \t]*/.exec(src.slice(lineStart))?.[0] ?? "";
    const start = lineStart + indent.length;
    const semi = scanTo(src, m.index, ";");
    if (semi === null) continue;
    const text = norm(src.slice(start, semi + 1));
    // The locator note after it on the same line goes with it.
    const tail = /^[ \t]*\/\/[^\n]*/.exec(src.slice(semi + 1));
    out.push({ start, end: semi + 1 + (tail?.[0].length ?? 0), indent, text });
  }
  return out;
}

/** The index of the next `ch` at bracket depth 0, strings skipped. */
function scanTo(src: string, from: number, ch: string): number | null {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i += 1; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === ch && depth === 0) return i;
  }
  return null;
}

/** Rendered statement without its comment, normalised. */
const rendered = (op: OutlineOp) => {
  const line = renderOp(op).trim();
  const semi = scanTo(line, 0, ";");
  return norm(semi === null ? line : line.slice(0, semi + 1));
};

/**
 * The op's statement in the source. The same statement can appear more than
 * once (two steps both click "Next"): the k-th in the outline is the k-th in
 * the source, and only when the counts agree.
 */
function statementOf(src: string, outline: Outline, stepIndex: number, opIndex: number) {
  const target = browserStep(outline, stepIndex).ops[opIndex];
  if (!target || target.kind === "human") return null;
  const want = rendered(target);
  let k = 0;
  let total = 0;
  outline.steps.forEach((s, si) => {
    if (s.kind !== "browser") return;
    s.ops.forEach((op, oi) => {
      if (op.kind === "human" || rendered(op) !== want) return;
      total += 1;
      if (si < stepIndex || (si === stepIndex && oi < opIndex)) k += 1;
    });
  });
  const found = statements(src).filter((s) => s.text === want);
  return found.length === total ? (found[k] ?? null) : null;
}
