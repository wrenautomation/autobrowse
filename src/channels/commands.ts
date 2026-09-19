/**
 * What a person types back, on any channel, becomes one command. Short
 * words first (`yes`, `no`, `pause`), then an optional run: `yes domain
 * wren-six.com`. A bare answer targets the newest open gate.
 */
export type Command =
  | { kind: "approve" | "reject"; run: RunSpec | null; note: string | null }
  | { kind: "pause" | "play" | "status" | "reset"; run: RunSpec | null };

export interface RunSpec {
  workflow: string;
  key: string;
}

const YES = /^(y|yes|ok|okay|approve|approved|go|do it|sure|yep)\b/i;
const NO = /^(n|no|nope|reject|rejected|stop|cancel|don't|dont)\b/i;
const VERBS: Record<string, "pause" | "play" | "status" | "reset"> = {
  pause: "pause",
  play: "play",
  resume: "play",
  continue: "play",
  status: "status",
  reset: "reset",
};

export interface ParseOptions {
  /** Known workflow names; with them, "yes looks fine" is a note, not run "looks/fine". */
  workflows?: readonly string[];
}

export function parseCommand(text: string, opts: ParseOptions = {}): Command | null {
  const t = text.trim();
  if (!t) return null;
  const words = t.split(/\s+/);
  const head = (words[0] ?? "").toLowerCase();
  const verb = VERBS[head];
  if (verb) return { kind: verb, run: runSpec(words.slice(1), opts) };
  const answer = YES.test(t) ? "approve" : NO.test(t) ? "reject" : null;
  if (!answer) return null;
  // "yes domain wren-six.com looks fine" → run + note
  const rest = t.replace(YES, "").replace(NO, "").trim().split(/\s+/).filter(Boolean);
  const run = runSpec(rest, opts);
  const noteWords = run ? rest.slice(2) : rest;
  const note = noteWords.join(" ").replace(/^[,:-]\s*/, "") || null;
  return { kind: answer, run, note };
}

/** `<workflow> <key>` when both look like one; keys are domains, emails, slugs. */
function runSpec(words: string[], opts: ParseOptions): RunSpec | null {
  const [workflow, key] = words;
  if (!workflow || !key) return null;
  if (!/^[a-z][a-z0-9-]*$/.test(workflow)) return null;
  if (opts.workflows && !opts.workflows.includes(workflow)) return null;
  if (!/^[a-z0-9][a-z0-9.@_-]*$/i.test(key)) return null;
  return { workflow, key };
}
