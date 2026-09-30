/**
 * `finish(dir)`: a model does the last mile a person did by hand on every
 * compiled workflow so far — plan inputs for what the recording hard-coded,
 * fill and submit as two steps with a `send` gate before the irreversible
 * one, a proof read after it, a gate test — inside the same loop a person
 * uses: typecheck and test, feed the errors back, try again, a few rounds.
 * The model may touch the module and its test, nothing else; a round that
 * still fails leaves the files as they were. The model proposes, tsc and
 * vitest dispose.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Llm, LlmUsage } from "../llm/types.js";
import { OUTLINE_FILE } from "./outline.js";

export const MODULE_FILE = "index.ts";
export const TEST_FILE = "index.test.ts";

export interface FinishOptions {
  llm: Llm;
  /** The compiled workflow's directory: `index.ts`, `index.test.ts`, `outline.json`. */
  dir: string;
  /** Typecheck and test the directory; null when both pass, else what failed. */
  check: (dir: string) => Promise<string | null>;
  /** Model rounds before giving up (each one sees the check's errors). */
  rounds?: number;
  /** Called after each failed round: the round, what failed. */
  onRound?: (round: number, errors: string) => void;
  /** Something the caller wants said: the heal's context, a person's note. */
  brief?: string;
  /** A finished workflow to imitate (module and test). */
  exemplar?: { module: string; test: string } | null;
  /** Formatter over the written files, best effort. */
  format?: (files: string[]) => Promise<void>;
}

export interface FinishOutcome {
  status: "finished" | "unchanged" | "gave-up";
  rounds: number;
  usage: LlmUsage;
  /** The model's own notes, or the last check's errors when it gave up. */
  summary: string;
}

export interface FinishReply {
  unchanged: boolean;
  module: string | null;
  test: string | null;
  notes: string;
}

/**
 * Whole files come back between markers, not inside JSON: a 100-line module
 * with quotes, backslashes and newlines in it survives a marker and does not
 * survive a model's JSON escaping (command-a-plus emitted invalid JSON every
 * round until this changed).
 */
export function parseReply(text: string): FinishReply {
  if (/^\s*UNCHANGED\b/m.test(text))
    return { unchanged: true, module: null, test: null, notes: after(text, "NOTES") };
  return {
    unchanged: false,
    module: section(text, MODULE_FILE),
    test: section(text, TEST_FILE),
    notes: after(text, "NOTES"),
  };
}

const marker = (name: string) =>
  new RegExp(`^===+\\s*${name.replace(".", "\\.")}\\s*===+\\s*$`, "m");

/** The text under `=== <name> ===` up to the next marker line, fences stripped. */
function section(text: string, name: string): string | null {
  const open = marker(name).exec(text);
  if (!open?.index && open?.index !== 0) return null;
  const from = open.index + open[0].length;
  const next = /^===+\s*[\w.]+\s*===+\s*$/m.exec(text.slice(from));
  const body = next ? text.slice(from, from + next.index) : text.slice(from);
  const fenced = /```(?:\w+)?\n([\s\S]*?)```/.exec(body);
  const out = clean(fenced?.[1] ?? body).trim();
  return out ? `${out}\n` : null;
}

/**
 * Characters a model emits that a compiler will not take: zero-width marks,
 * a non-breaking space where a space belongs, smart quotes around code.
 * (command-a-plus put one in the middle of an identifier: "Invalid character".)
 */
export function clean(code: string): string {
  return code
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

function after(text: string, name: string): string {
  return (section(text, name) ?? "").trim().split("\n")[0] ?? "";
}

const SYSTEM = `You finish a compiled browser workflow so it is safe to run unattended. You get its module (index.ts), its test (index.test.ts) and the outline it was rendered from. Rewrite the module and the test; nothing else exists to you.

What to finish:
1. Plan inputs. Every value the recording hard-coded that another run would change (a title, an address, a search term, a file, a message) becomes a field of planSchema with .describe("<the control's label>") and the recorded value as a "// e.g." comment; the flows read it from their input. Keep dryRun. Values that are the site's own (a URL path, a button name) stay in the code.
2. Two steps where one fills and then sends. A step that fills a form and clicks a button that submits, posts, sends, buys or creates becomes two steps: a reversible one that fills and stops, and an irreversible one (irreversible: true) that opens a gate first: gate("send", ...) for anything filed, posted or sent in the person's name, gate("purchase", ...) for money, gate("password", ...) for a credential change. The prompt says what will happen with the plan's values in it. Never gate("human") in a step. A declined gate returns rejected(answer.note ?? "declined"). Give the flow a boolean input (submit) so the fill step calls it with false and the send step with true.
3. Proof reads. After the irreversible act the flow waits briefly, reads what the page says (fp.text(), or fp.read(hints) for one element) and returns it; the step keeps it in memo and in done("..."). Re-runs skip when memo already has it. When the page shows an error and the send button is still there, fp.human("...") with the reason.
4. Tests: keep the dry-run test; add one that runs to the gate ("waiting"), then answers it and runs to "done", asserting the fake browser saw submit false then true. Fake the browser with { run: async (_flow, input) => ... } as never.

The library (imported from the same path the module already uses). Its only exports you may import: defineFlow, defineWorkflow, done, skipped, rejected, memoryEffects, runFlow, type FlowRunner, type StepDef. fp is the flow's run(fp, input) parameter; gate, fx, memo, plan and deps come from the step's run({ ... }) context: never import them.
- defineFlow<I, O>({ site, name, run(fp, input) }), FlowRunner { run(flow, input) }
- fp.open(url), fp.url(), fp.text(), fp.html(), fp.has(hints, withinMs?), fp.read(hints), fp.wait(ms), fp.waitForUrl(re, ms), fp.act(op, hints, { goal, irreversible? }), fp.human(reason): never
- op: { kind: "click" } | { kind: "fill", value } | { kind: "select", value } | { kind: "press", key } | { kind: "upload", files: [...] }
- hints: { role, name } (name may be a "/regex/i" string), { text }, { label }, { placeholder }, { css }, { testId }
- StepDef<Plan, Deps, Memo, Name> { name, irreversible?, run({ fx, deps, plan, memo, gate }) }; fx.run("label", () => ...) journals one effect; gate(name, prompt) returns { approved, note }
- done(detail), skipped(detail), rejected(detail); defineWorkflow<Deps, Memo>()({ name, description, plan, steps, emptyMemo })
- tests: runFlow(memoryEffects().fx, workflow, deps, plan, answer?) → { status: "planned"|"waiting"|"done"|"rejected"|"failed", results: { [step]: { status, detail } } }; answer = (gate: { name, prompt }) => ({ approved: true, note: null, at: new Date().toISOString() })

Keep every behaviour: each deps member the module uses, each sink.put (a value the recording kept for later), each upload, each read that feeds a later step stays; you add gates, inputs and proof reads, you never drop what the recording did.

Rules: TypeScript, strict, exactOptionalPropertyTypes (no undefined into an optional field); imports only from the library path the module already uses, "zod", "vitest"; keep the module's header comment and add one line saying what was finished; kebab-case step names; no Playwright calls; no new dependencies; no secrets in code. Reply with the three sections below and nothing else — no JSON, no code fences, no commentary:

=== index.ts ===
<the whole file>
=== index.test.ts ===
<the whole file>
=== NOTES ===
<one line saying what you changed>

When the module already meets every point, reply with the single word UNCHANGED, then a === NOTES === section saying why.`;

export async function finish(o: FinishOptions): Promise<FinishOutcome> {
  const rounds = o.rounds ?? 3;
  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  const paths = { module: join(o.dir, MODULE_FILE), test: join(o.dir, TEST_FILE) };
  const original = {
    module: await readFile(paths.module, "utf8"),
    test: await readFile(paths.test, "utf8"),
  };
  const outline = await readFile(join(o.dir, OUTLINE_FILE), "utf8").catch(() => null);
  let prompt = [
    o.brief ? `Context: ${o.brief}\n` : "",
    o.exemplar
      ? `A DIFFERENT workflow, finished, to imitate in shape only — never copy its plan fields, its site, its URLs or its step names:\n--- example/index.ts ---\n${o.exemplar.module}\n--- example/index.test.ts ---\n${o.exemplar.test}\n`
      : "",
    outline ? `--- outline.json ---\n${outline}\n` : "",
    `--- ${MODULE_FILE} ---\n${original.module}\n--- ${TEST_FILE} ---\n${original.test}`,
  ].join("\n");
  let last = "";
  const restore = async () => {
    await writeFile(paths.module, original.module);
    await writeFile(paths.test, original.test);
  };
  for (let round = 1; round <= rounds; round++) {
    let value: FinishReply;
    try {
      ({ value } = await ask());
    } catch (err) {
      // A model or network failure mid-loop must not leave a half-finished module behind.
      await restore();
      throw err;
    }
    if (value.unchanged) {
      if (round === 1) return { status: "unchanged", rounds: round, usage, summary: value.notes };
      break;
    }
    const module = value.module ?? original.module;
    const test = value.test ?? original.test;
    if (!value.module && !value.test) {
      last = `no ${MODULE_FILE} section in your reply`;
      prompt = `${last}. Reply again with the markers exactly as asked.\n\n${prompt}`;
      continue;
    }
    await writeFile(paths.module, module);
    await writeFile(paths.test, test);
    if (o.format) await o.format([paths.module, paths.test]);
    // tsc cannot see dropped behaviour; the deps the recording used are the cheap tell.
    const errors = dropped(original.module, module) ?? (await o.check(o.dir));
    if (!errors) return { status: "finished", rounds: round, usage, summary: value.notes };
    last = errors;
    o.onRound?.(round, errors);
    prompt = `Your files failed the check:\n${errors.slice(0, 6_000)}\n\nFix them and reply with both whole files again.\n--- ${MODULE_FILE} ---\n${module}\n--- ${TEST_FILE} ---\n${test}`;
  }
  await restore();
  return { status: "gave-up", rounds, usage, summary: last.slice(0, 600) };

  async function ask() {
    const r = await o.llm.complete({
      purpose: "compile-finish",
      system: SYSTEM,
      prompt,
      maxTokens: 20_000,
    });
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    return { value: parseReply(r.text) };
  }
}

/** Each pattern's capture is what must survive, whatever the rewrite's line breaks are. */
const KEPT: ReadonlyArray<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/deps\.(\w+)/g, (m) => `deps.${m[1]}`],
  [/\.put\(\s*"([^"]+)"/g, (m) => `.put("${m[1]}"`],
  [/\.act\(\s*\{\s*kind:\s*"upload"/g, () => 'act({ kind: "upload"'],
];

/** Whitespace between tokens never means anything in TypeScript; a rewrite reflows freely. */
const flat = (s: string) => s.replace(/\s+/g, " ");

/** What the original did that the rewrite no longer does; null when nothing was lost. */
export function dropped(original: string, next: string): string | null {
  const there = flat(next);
  const lost: string[] = [];
  for (const [re, name] of KEPT) {
    for (const m of flat(original).matchAll(re)) {
      const want = name(m);
      if (!there.includes(want) && !lost.includes(want)) lost.push(want);
    }
  }
  return lost.length
    ? `behaviour dropped: the original used ${lost.join(", ")} and your files do not. Keep every one of them, in the same step or a new one.`
    : null;
}
