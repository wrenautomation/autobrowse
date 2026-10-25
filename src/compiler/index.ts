/**
 * `compile(recording)`: structure → (polish) → render. The outline is
 * saved beside the recording so it can be edited and re-rendered
 * without the model; the rendered files go to `out/<name>/`.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Llm, LlmUsage } from "../llm/types.js";
import type { Recording } from "../recorder/types.js";
import { cleanOutline, type Known, type LintHit, lintFiles } from "./lint.js";
import { OUTLINE_FILE, type Outline, outlineSchema } from "./outline.js";
import { polish } from "./polish.js";
import { type Rendered, type RenderOptions, render } from "./render.js";
import { structure } from "./structure.js";

export interface CompileOptions extends RenderOptions {
  llm?: Llm | null;
  /** The person's values in this recording (the account's username): placeholders, then lint. */
  known?: readonly Known[];
}

export interface Compiled extends Rendered {
  outline: Outline;
  usage: LlmUsage | null;
  /** The operator's plan defaults: every value the recording typed, by field (the plan file's content). */
  defaults: Record<string, string>;
  /** Personal data still in the rendered files; empty when the workflow may be shared as it is. */
  lint: LintHit[];
  /** Where the defaults were saved, when a store took them. */
  defaultsFile?: string;
}

/** The files a person reads at compile time, with a line each; the test's fake values are its own. */
const LINT_KNOWN_ONLY = ["index.test.ts"];

export async function compile(rec: Recording, opts: CompileOptions = {}): Promise<Compiled> {
  const known = opts.known ?? [];
  let outline = structure(rec, { known });
  let usage: LlmUsage | null = null;
  if (opts.llm) ({ outline, usage } = await polish(outline, opts.llm));
  const clean = cleanOutline(outline);
  const rendered = render(clean.outline, opts);
  return {
    outline: clean.outline,
    usage,
    defaults: clean.defaults,
    lint: lintFiles(rendered.files, known, { knownOnly: LINT_KNOWN_ONLY }),
    ...rendered,
  };
}

/** Render an outline and write module, test and outline into `dir`: the one way an edit or a heal lands. */
export async function rerender(
  dir: string,
  outline: Outline,
  opts: RenderOptions = {},
): Promise<Compiled> {
  const rendered = render(outline, opts);
  const out: Compiled = {
    outline,
    usage: null,
    defaults: {},
    lint: lintFiles(rendered.files, [], { knownOnly: LINT_KNOWN_ONLY }),
    ...rendered,
  };
  await writeRendered(dir, out);
  await saveOutline(dir, outline);
  return out;
}

export async function saveOutline(dir: string, outline: Outline): Promise<string> {
  const file = join(dir, OUTLINE_FILE);
  await writeFile(file, `${JSON.stringify(outline, null, 2)}\n`);
  return file;
}

export async function loadOutline(dir: string): Promise<Outline> {
  return outlineSchema.parse(JSON.parse(await readFile(join(dir, OUTLINE_FILE), "utf8")));
}

export async function writeRendered(dir: string, r: Rendered): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const out: string[] = [];
  for (const [name, src] of Object.entries(r.files)) {
    const file = join(dir, name);
    await writeFile(file, src);
    out.push(file);
  }
  await format(out);
  return out;
}

/** The repo's formatter over what was written, so compiled code passes the same gates as hand-written code. Best effort. */
export async function format(files: string[]): Promise<void> {
  const biome = join(process.cwd(), "node_modules", ".bin", "biome");
  if (!existsSync(biome)) return;
  await new Promise<void>((resolve) => {
    execFile(biome, ["check", "--write", ...files], { timeout: 30_000 }, () => resolve());
  });
}

export { checkCompiled } from "./check.js";
export { type FinishOptions, type FinishOutcome, finish } from "./finish.js";
export {
  cleanOutline,
  formatHits,
  type Known,
  type LintHit,
  lintFiles,
  lintOutline,
} from "./lint.js";
export { OUTLINE_FILE, type Outline, type OutlineStep, outlineSchema } from "./outline.js";
export { polish } from "./polish.js";
export { type Rendered, type RenderOptions, render } from "./render.js";
export { structure } from "./structure.js";
