/**
 * Terminal emphasis for CLI output. Plain text when stdout is not a terminal
 * or NO_COLOR is set, so pipes, files and tests see the same bytes as before.
 * Pad before painting: escape codes have no width but count in `padEnd`.
 */

import { styleText } from "node:util";

const on = (): boolean => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const paint =
  (format: Parameters<typeof styleText>[0]) =>
  (s: string): string =>
    on() ? styleText(format, s, { validateStream: false }) : s;

/** A heading: a platform, a group. */
export const bold = paint("bold");
/** What a reader can skip: a stored key, a command to copy, a timestamp. */
export const dim = paint("dim");
export const good = paint("green");
export const warn = paint("yellow");
export const bad = paint("red");
/** A name a person types: a role, a workflow. */
export const accent = paint("cyan");

/** Visible width: escape codes take no room. */
export const width = (s: string): string["length"] =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
  s.replace(/\x1b\[[0-9;]*m/g, "").length;

/**
 * Rows as aligned columns, two spaces apart, each cell measured by what
 * shows. The last column is never padded.
 */
export function columns(rows: readonly string[][]): string[] {
  const n = Math.max(0, ...rows.map((r) => r.length));
  const w = Array.from({ length: n }, (_, i) => Math.max(0, ...rows.map((r) => width(r[i] ?? ""))));
  return rows.map((r) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c + " ".repeat((w[i] ?? 0) - width(c))))
      .join("  ")
      .trimEnd(),
  );
}
