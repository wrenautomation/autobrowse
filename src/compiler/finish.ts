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
import { z } from "zod";
import { completeJson, type Llm, type LlmUsage } from "../llm/types.js";
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

const replySchema = z.object({
  unchanged: z.boolean().optional(),
  [MODULE_FILE]: z.string().optional(),
  [TEST_FILE]: z.string().optional(),
  notes: z.string().default(""),
});

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

Rules: TypeScript, strict, exactOptionalPropertyTypes (no undefined into an optional field); imports only from the library path the module already uses, "zod", "vitest"; keep the module's header comment and add one line saying what was finished; kebab-case step names; no Playwright calls; no new dependencies; no secrets in code. Reply with JSON: {"index.ts": "<whole file>", "index.test.ts": "<whole file>", "notes": "<one line>"}. When the module already meets every point, reply {"unchanged": true, "notes": "<why>"}.`;

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
      ? `A finished workflow to imitate:\n--- index.ts ---\n${o.exemplar.module}\n--- index.test.ts ---\n${o.exemplar.test}\n`
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
    let value: z.infer<typeof replySchema>;
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
    const module = value[MODULE_FILE] ?? original.module;
    const test = value[TEST_FILE] ?? original.test;
    await writeFile(paths.module, module);
    await writeFile(paths.test, test);
    if (o.format) await o.format([paths.module, paths.test]);
    const errors = await o.check(o.dir);
    if (!errors) return { status: "finished", rounds: round, usage, summary: value.notes };
    last = errors;
    prompt = `Your files failed the check:\n${errors.slice(0, 6_000)}\n\nFix them and reply with both whole files again.\n--- ${MODULE_FILE} ---\n${module}\n--- ${TEST_FILE} ---\n${test}`;
  }
  await restore();
  return { status: "gave-up", rounds, usage, summary: last.slice(0, 600) };

  async function ask() {
    const r = await completeJson(o.llm, replySchema, { system: SYSTEM, prompt, maxTokens: 8_000 });
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    return r;
  }
}
