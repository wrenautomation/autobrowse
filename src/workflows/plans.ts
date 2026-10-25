/**
 * A workflow's saved default plan: `<plansDir>/<workflow>.json`, the operator's
 * own values for a workflow whose source names no one. Every start (`run`,
 * `try`, a proof, the UI) merges it under what the caller gives; a compile
 * writes it once from what the recording typed and never overwrites a value
 * (designs/2026-10-24-operator-defaults.md).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expandHome } from "../google/auth.js";

export type PlanValues = Record<string, unknown>;

export interface PlanStore {
  /** The saved defaults; `{}` when there is no file. */
  get(name: string): Promise<PlanValues>;
  /** Save defaults. `keep`: a key already saved wins and new keys are added; without it the file is replaced. */
  put(name: string, values: PlanValues, o?: { keep?: boolean }): Promise<string>;
  /** Where `name`'s file is. */
  path(name: string): string;
}

const NAME = /^[a-z][a-z0-9-]*$/;

export function filePlans(dir: string): PlanStore {
  const root = expandHome(dir);
  const path = (name: string): string => {
    if (!NAME.test(name)) throw new Error(`plan ${name}: lowercase letters, digits and -`);
    return join(root, `${name}.json`);
  };
  const get = async (name: string): Promise<PlanValues> => {
    let text: string;
    try {
      text = await readFile(path(name), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
    const v: unknown = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v))
      throw new Error(`${path(name)}: a JSON object of plan fields`);
    return v as PlanValues;
  };
  return {
    path,
    get,
    async put(name, values, o = {}) {
      const file = path(name);
      const kept = o.keep ? await get(name) : {};
      await mkdir(root, { recursive: true });
      await writeFile(file, `${JSON.stringify({ ...values, ...kept }, null, 2)}\n`);
      return file;
    },
  };
}

/** The plan a start runs: the saved defaults under what the caller gave. */
export async function withDefaults(
  plans: PlanStore | undefined,
  name: string,
  given: PlanValues,
): Promise<PlanValues> {
  return { ...(plans ? await plans.get(name) : {}), ...given };
}
