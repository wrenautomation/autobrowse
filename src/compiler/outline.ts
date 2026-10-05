/**
 * The outline is the compiler's middle: a recording reduced to named
 * steps, typed inputs, and replayable ops. It is plain data with a
 * schema, saved next to the recording as `outline.json`, so a person or a
 * model can edit it (names, proofs, gates) before source is rendered.
 * Values a person typed become plan fields; redacted ones become secrets
 * fetched by key at run time, never stored anywhere.
 */
import { z } from "zod";

export const hintsSchema = z.object({
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
  /** The iframe the element is in, by CSS selector. */
  frame: z.string().nullable().optional(),
});

/** Where a fill's text comes from at run time. */
export const valueSchema = z.union([
  z.object({ from: z.literal("plan"), field: z.string() }),
  z.object({ from: z.literal("secret"), key: z.string() }),
  z.object({ from: z.literal("literal"), text: z.string() }),
]);

export const opSchema = z.discriminatedUnion("kind", [
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
  /** Text read off an element, kept under `as` in the step's result. */
  z.object({
    kind: z.literal("read"),
    goal: z.string(),
    hints: hintsSchema,
    as: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
  }),
  /** A secret read off the page into the sink under an env name; never in the plan, result or journal. */
  z.object({
    kind: z.literal("keep"),
    goal: z.string(),
    hints: hintsSchema,
    env: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  }),
  /** The recorder was paused here: a person did something private. */
  z.object({ kind: z.literal("human"), reason: z.string() }),
  /**
   * Rows of named fields off a list page, by code a model wrote once and the checker passed
   * (src/browser/records.ts); a replay runs the code with no model. Kept under `as`.
   */
  z.object({
    kind: z.literal("records"),
    goal: z.string(),
    as: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
    fields: z
      .array(
        z.object({
          key: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
          says: z.string(),
          /** Often empty on a real row (a link not every ad has): not counted against the code. */
          optional: z.boolean().optional(),
        }),
      )
      .min(1),
    /** The field one row is one of: rows are deduped by it, and a feed scrolls until it repeats. */
    key: z.string(),
    /** A function body over `root` (the document) that returns an array of plain objects. */
    code: z.string(),
    /** Fewest rows a working read gives (half of the first read's); fewer: the page changed. */
    min: z.number().int().nonnegative(),
    /** Scroll for more rows up to this many (a feed); absent: what the page shows. */
    max: z.number().int().positive().optional(),
    /** Rows a model read off the page by eye when the code was written: the code found them. */
    sample: z.array(z.record(z.string(), z.string().nullable())).max(5),
  }),
  /** A model call at run time, in the open and capped: a prompt over earlier reads, kept under `as`. */
  z.object({
    kind: z.literal("ai"),
    goal: z.string(),
    as: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
    /** `{name}`: an earlier read's text, or an earlier records' rows as JSON. */
    prompt: z.string(),
    /** cheap: Cohere when keyed, else Claude Code ($0); smart: the configured model. */
    model: z.enum(["cheap", "smart"]),
    maxTokens: z.number().int().positive().max(4000),
  }),
]);

/**
 * Desktop ops replay through `deps.desktop`. Typed text is a value like a
 * fill's (plan field, secret, or literal); a root command is irreversible
 * by default and gated.
 */
const desktopOpSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open"), goal: z.string(), app: z.string() }),
  z.object({
    kind: z.literal("click"),
    goal: z.string(),
    app: z.string().nullable(),
    role: z.string().nullable(),
    name: z.string(),
    irreversible: z.boolean(),
  }),
  z.object({ kind: z.literal("type"), goal: z.string(), value: valueSchema }),
  z.object({ kind: z.literal("key"), goal: z.string(), combo: z.string() }),
  z.object({ kind: z.literal("shell"), goal: z.string(), command: z.string(), root: z.boolean() }),
  z.object({ kind: z.literal("wait"), goal: z.string(), ms: z.number().int().positive() }),
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
  z.object({ ...stepBase, kind: z.literal("desktop"), ops: z.array(desktopOpSchema) }),
]);

export const outlineSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    site: z.string(),
    description: z.string(),
    fields: z.array(fieldSchema),
    secrets: z.array(secretSchema),
    steps: z.array(stepSchema),
  })
  .superRefine((o, ctx) => {
    // `{project}` in a step URL is a plan field, so it has to be one the plan declares.
    const declared = new Set(o.fields.map((f) => f.key));
    o.steps.forEach((step, i) => {
      if (step.kind !== "browser" || !step.url) return;
      for (const m of step.url.matchAll(/\{([a-z][a-zA-Z0-9]*)\}/g)) {
        if (!declared.has(m[1] as string))
          ctx.addIssue({
            code: "custom",
            path: ["steps", i, "url"],
            message: `url names plan field {${m[1]}} which fields does not declare`,
          });
      }
    });
  });

export type Outline = z.infer<typeof outlineSchema>;
export type OutlineStep = Outline["steps"][number];
export type OutlineOp = z.infer<typeof opSchema>;
export type DesktopOutlineOp = z.infer<typeof desktopOpSchema>;
export type OutlineField = z.infer<typeof fieldSchema>;
export type OpValue = z.infer<typeof valueSchema>;

export const OUTLINE_FILE = "outline.json";
