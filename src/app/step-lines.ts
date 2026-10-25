/**
 * How `try` and `try --prove` print each step: name, status, detail on one line. A compiled step's
 * detail is its `out` as JSON: then each value goes on its own line, and a list one row per line.
 */
export interface StepLine {
  name: string;
  status: string;
  detail: string;
}

export function stepLines(steps: readonly StepLine[]): string[] {
  const width = Math.max(0, ...steps.map((s) => s.name.length));
  return steps.flatMap((s) => {
    const out = outOf(s.detail);
    const head = `${s.name.padEnd(width)}  ${s.status}`;
    if (!out) return [s.detail ? `${head}  ${s.detail}` : head];
    return [head, ...Object.entries(out).flatMap(([key, v]) => valueLines(key, v))];
  });
}

const outOf = (detail: string): Record<string, unknown> | null => {
  if (!detail.startsWith("{")) return null;
  try {
    const v: unknown = JSON.parse(detail);
    return isRecord(v) && Object.keys(v).length ? v : null;
  } catch {
    return null;
  }
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const flat = (v: unknown) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));

function valueLines(key: string, v: unknown): string[] {
  if (Array.isArray(v) && v.length && v.every(isRecord))
    return [`  ${key}`, ...v.map((row) => `    ${Object.values(row).map(flat).join("  ")}`)];
  return [`  ${key}  ${flat(v)}`];
}
