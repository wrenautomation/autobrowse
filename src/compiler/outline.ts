/**
 * The outline is the compiler's middle: a recording reduced to named
 * steps, typed inputs, and replayable ops. It is plain data with a
 * schema, saved next to the recording as `outline.json`, so a person or a
 * model can edit it (names, proofs, gates) before source is rendered.
 * Values a person typed become plan fields; redacted ones become secrets
 * fetched by key at run time, never stored anywhere.
 */
import { z } from "zod";

const hintsSchema = z.object({
  tag: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  placeholder: z.string().nullable().optional(),
  id: z.string().nullable().optional(),
  testId: z.string().nullable().optional(),
  href: z.string().nullable().optional(),
  inputType: z.string().nullable().optional(),
  css: z.string().nullable().optional(),
  nth: z.number().int().nonnegative().nullable().optional(),
});

/** Where a fill's text comes from at run time. */
const valueSchema = z.union([
  z.object({ from: z.literal("plan"), field: z.string() }),
  z.object({ from: z.literal("secret"), key: z.string() }),
  z.object({ from: z.literal("literal"), text: z.string() }),
]);

const opSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("click"),
    goal: z.string(),
    hints: hintsSchema,
    irreversible: z.boolean(),
  }),
  z.object({ kind: z.literal("fill"), goal: z.string(), hints: hintsSchema, value: valueSchema }),
  z.object({ kind: z.literal("select"), goal: z.string(), hints: hintsSchema, value: z.string() }),
  z.object({ kind: z.literal("press"), goal: z.string(), hints: hintsSchema, key: z.string() }),
  /** One file, a path from the plan or a literal. */
  z.object({ kind: z.literal("upload"), goal: z.string(), hints: hintsSchema, file: valueSchema }),
  /** The recorder was paused here: a person did something private. */
  z.object({ kind: z.literal("human"), reason: z.string() }),
]);

export const fieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
  label: z.string(),
  example: z.string().nullable(),
});

export const secretSchema = z.object({
  key: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
  label: z.string(),
});

const stepBase = {
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  description: z.string(),
  irreversible: z.boolean(),
  /** How the step proves it worked after the browser part, in words; rendered as a TODO. */
  proof: z.string().nullable(),
};

export const stepSchema = z.discriminatedUnion("kind", [
  z.object({
    ...stepBase,
    kind: z.literal("browser"),
    url: z.string().nullable(),
    ops: z.array(opSchema),
  }),
  z.object({ ...stepBase, kind: z.literal("terminal"), commands: z.array(z.string()) }),
]);

export const outlineSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  site: z.string(),
  description: z.string(),
  fields: z.array(fieldSchema),
  secrets: z.array(secretSchema),
  steps: z.array(stepSchema),
});

export type Outline = z.infer<typeof outlineSchema>;
export type OutlineStep = Outline["steps"][number];
export type OutlineOp = z.infer<typeof opSchema>;
export type OutlineField = z.infer<typeof fieldSchema>;
export type OpValue = z.infer<typeof valueSchema>;

export const OUTLINE_FILE = "outline.json";
