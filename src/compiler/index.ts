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
import { OUTLINE_FILE, type Outline, outlineSchema } from "./outline.js";
import { polish } from "./polish.js";
import { type Rendered, type RenderOptions, render } from "./render.js";
import { structure } from "./structure.js";

export interface CompileOptions extends RenderOptions {
  llm?: Llm | null;
}

export interface Compiled extends Rendered {
  outline: Outline;
  usage: LlmUsage | null;
}

export async function compile(rec: Recording, opts: CompileOptions = {}): Promise<Compiled> {
  let outline = structure(rec);
  let usage: LlmUsage | null = null;
  if (opts.llm) ({ outline, usage } = await polish(outline, opts.llm));
  return { outline, usage, ...render(outline, opts) };
}

/** Render an outline and write module, test and outline into `dir`: the one way an edit or a heal lands. */
export async function rerender(
  dir: string,
  outline: Outline,
  opts: RenderOptions = {},
): Promise<Compiled> {
  const out: Compiled = { outline, usage: null, ...render(outline, opts) };
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
export { OUTLINE_FILE, type Outline, type OutlineStep, outlineSchema } from "./outline.js";
export { polish } from "./polish.js";
export { type Rendered, type RenderOptions, render } from "./render.js";
export { structure } from "./structure.js";
