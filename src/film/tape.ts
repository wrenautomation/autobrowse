/**
 * A tape: what the director types into its terminal, step by step
 * (designs/2026-10-24-film.md, "Tape").
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";

const Step = z.union([
  /** Type the line, then press Enter. */
  z.object({ type: z.string().min(1) }).strict(),
  /** Press one key (`Enter`, `ArrowDown`, `y`). */
  z.object({ press: z.string().min(1) }).strict(),
  /** Wait until the terminal shows this text. */
  z.object({ wait: z.string().min(1), timeoutS: z.number().positive().default(60) }).strict(),
  /** Hold. */
  z.object({ sleepS: z.number().nonnegative() }).strict(),
]);
export type TapeStep = z.infer<typeof Step>;

export const Tape = z
  .object({
    /** The page, CSS px. */
    size: z.tuple([z.number().int().min(320), z.number().int().min(240)]).default([1920, 1080]),
    theme: z.enum(["dark", "light"]).default("dark"),
    fontSize: z.number().int().min(8).max(64).default(26),
    /** The shell starts here; default the folder `film` runs in. */
    cwd: z.string().min(1).optional(),
    steps: z.array(Step).min(1),
  })
  .strict();
export type Tape = z.infer<typeof Tape>;

export async function loadTape(file: string): Promise<Tape> {
  const parsed = Tape.safeParse(JSON.parse(await readFile(file, "utf8")));
  if (!parsed.success)
    throw new Error(`film: ${file} is not a tape: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
