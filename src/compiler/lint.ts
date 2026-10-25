/**
 * Personal data in a compiled workflow: the one rule behind `compile`'s
 * report, a `finish` round, the registry gate and the repo's own test
 * (designs/2026-10-24-operator-defaults.md). Two passes: the shapes
 * `redactPii` masks (an address, a phone number, a home folder, an IP, a
 * long id, a secret), and the values known to this recording (the account's
 * username, what the person typed). A hit names the place and the kind,
 * never the value.
 */
import { personalKinds } from "../recorder/redact.js";
import type { Known } from "../share/scrub.js";
import type { DesktopOutlineOp, Outline, OutlineOp } from "./outline.js";

export type { Known };

export interface LintHit {
  file: string;
  line: number;
  kind: string;
}

/** A known value shorter than this is too common a string to flag. */
const KNOWN_MIN = 3;

/**
 * Shapes the patterns read as personal that name no one: a documentation or
 * loopback IP (RFC 5737, 127/8, 0.0.0.0), an `example.com` or `.test` address, a
 * version (`Chrome/129.0.0.0`), and a long name with no digit or with a `__`
 * in it (a CSS class, a Relay field), which is a name and not a token.
 */
const EXAMPLES: RegExp[] = [
  /\b(?:192\.0\.2|198\.51\.100|203\.0\.113|127(?:\.\d{1,3}){2}|0\.0\.0)\.\d{1,3}\b/g,
  /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)*(?:example\.(?:com|org|net)|[A-Za-z0-9-]+\.test)\b/g,
  /\b[A-Za-z]+\/\d+(?:\.\d+){1,3}\b/g,
  /\b[A-Za-z_-]{40,}\b/g,
  /\b[A-Za-z0-9_-]*__[A-Za-z0-9_-]*\b/g,
];
const withoutExamples = (text: string): string =>
  EXAMPLES.reduce((t, re) => t.replace(re, ""), text);

/** The kinds found in one piece of text: pattern kinds, then `known:<kind>` for each known value in it. */
export function lintText(text: string, known: readonly Known[] = []): string[] {
  const out = personalKinds(withoutExamples(text));
  for (const k of known)
    if (k.value.length >= KNOWN_MIN && text.includes(k.value)) out.push(`known:${k.kind}`);
  return out;
}

/** Hits in rendered files, by line. `knownOnly`: the known values alone (a test's fake addresses are fine). */
export function lintFiles(
  files: Record<string, string>,
  known: readonly Known[] = [],
  o: { knownOnly?: readonly string[] } = {},
): LintHit[] {
  const out: LintHit[] = [];
  for (const [file, src] of Object.entries(files)) {
    const onlyKnown = o.knownOnly?.includes(file) ?? false;
    src.split("\n").forEach((line, i) => {
      const kinds = onlyKnown
        ? lintText(line, known).filter((k) => k.startsWith("known:"))
        : lintText(line, known);
      for (const kind of kinds) out.push({ file, line: i + 1, kind });
    });
  }
  return out;
}

export const formatHits = (hits: readonly LintHit[]): string =>
  hits.map((h) => `${h.file}:${h.line}: ${h.kind}`).join("\n");

/** Hits in an outline, as `path: kind`. */
export function lintOutline(outline: Outline, known: readonly Known[] = []): string[] {
  const out: string[] = [];
  const at = (path: string, text: string | null | undefined) => {
    if (typeof text === "string") for (const k of lintText(text, known)) out.push(`${path}: ${k}`);
  };
  at("description", outline.description);
  outline.fields.forEach((f, i) => {
    at(`fields[${i}].label`, f.label);
    at(`fields[${i}].example`, f.example);
  });
  outline.steps.forEach((s, i) => {
    at(`steps[${i}].description`, s.description);
    if (s.kind === "browser") at(`steps[${i}].url`, s.url);
    if (s.kind === "terminal")
      for (const [j, c] of s.commands.entries()) at(`steps[${i}].commands[${j}]`, c);
    if (s.kind === "browser" || s.kind === "desktop")
      for (const [j, op] of (s.ops as readonly (OutlineOp | DesktopOutlineOp)[]).entries()) {
        const where = `steps[${i}].ops[${j}]`;
        if ("goal" in op) at(`${where}.goal`, op.goal);
        if ("hints" in op)
          for (const [k, v] of Object.entries(op.hints))
            if (typeof v === "string") at(`${where}.hints.${k}`, v);
        if ("value" in op && typeof op.value === "object" && op.value.from === "literal")
          at(`${where}.value`, op.value.text);
        if (op.kind === "shell") at(`${where}.command`, op.command);
      }
  });
  return out;
}

/**
 * The outline as it may be published, and the operator's defaults: every
 * field's example (what the person typed) goes to the defaults, the plan
 * file, and leaves the outline. A typed value is the operator's whatever its
 * shape (a handle has no PII shape), so none stays; the label says what the
 * field is, and `workflows <name>` shows the saved value.
 */
export function cleanOutline(outline: Outline): {
  outline: Outline;
  defaults: Record<string, string>;
} {
  const defaults: Record<string, string> = {};
  const fields = outline.fields.map((f) => {
    if (f.example === null) return f;
    defaults[f.key] = f.example;
    return { ...f, example: null };
  });
  return { outline: { ...outline, fields }, defaults };
}
