/**
 * What a workflow's plan or a site route's request takes, readable: one
 * row per field (type, required, default, what it is) and a JSON template
 * to fill in and pass back as `--plan file.json` or `--body file.json`.
 * One source for the CLI, the UI and the HTTP listing: the zod schema.
 */
import { z } from "zod";

export type JsonSchema = Record<string, unknown>;

export interface InputField {
  name: string;
  /** `string`, `number`, `"cloudflare"`, `a|b`, `{scope, name, level}[]`. */
  type: string;
  required: boolean;
  default?: unknown;
  about?: string;
}

/** Fields every plan carries that the CLI sets itself (`--dry-run`). */
const HOST_FIELDS = new Set(["dryRun"]);

export const jsonSchemaOf = (schema: z.ZodType): JsonSchema =>
  z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;

const props = (js: JsonSchema): Record<string, JsonSchema> =>
  (js.properties as Record<string, JsonSchema> | undefined) ?? {};

/** A short type a person reads: literals quoted, unions joined, arrays suffixed. */
export function typeOf(js: JsonSchema): string {
  if ("const" in js) return JSON.stringify(js.const);
  if (Array.isArray(js.enum)) return js.enum.map((v) => JSON.stringify(v)).join("|");
  const union = (js.anyOf ?? js.oneOf) as JsonSchema[] | undefined;
  if (union) return union.map(typeOf).join("|");
  if (js.type === "array") return `${typeOf((js.items as JsonSchema | undefined) ?? {})}[]`;
  if (js.type === "object" && js.properties) return `{${Object.keys(props(js)).join(", ")}}`;
  if (Array.isArray(js.type)) return js.type.join("|");
  return typeof js.type === "string" ? js.type : "any";
}

export const inputsOf = (schema: z.ZodType): InputField[] => inputsOfJson(jsonSchemaOf(schema));

/**
 * The same rows from JSON Schema that already crossed a wire (a site route's
 * `request`). An object's fields get a row each (`snippet.title`), and so do
 * an array of objects' (`permissions[].scope`); a parent's default fills its
 * children's.
 */
export function inputsOfJson(js: JsonSchema, prefix = "", parentDefault?: unknown): InputField[] {
  const required = new Set((js.required as string[] | undefined) ?? []);
  return Object.entries(props(js))
    .filter(([name]) => prefix || !HOST_FIELDS.has(name))
    .flatMap(([name, p]) => {
      const path = `${prefix}${name}`;
      const inherited =
        parentDefault && typeof parentDefault === "object"
          ? (parentDefault as Record<string, unknown>)[name]
          : undefined;
      const fallback = "default" in p ? p.default : inherited;
      const items = p.items as JsonSchema | undefined;
      if (p.type === "object" && p.properties) return inputsOfJson(p, `${path}.`, fallback);
      const row: InputField = {
        name: path,
        type: typeOf(p),
        required: required.has(name) && fallback === undefined,
        ...(fallback !== undefined ? { default: fallback } : {}),
        ...(typeof p.description === "string" ? { about: p.description } : {}),
      };
      // The list's own row says whether it is needed; its rows' fields are needed per row.
      if (p.type === "array" && items?.type === "object" && items.properties)
        return [row, ...inputsOfJson(items, `${path}[].`)];
      return [row];
    });
}

/** An empty value of the right shape: a required field left blank fails validation loudly. */
function blank(js: JsonSchema): unknown {
  if ("default" in js) return js.default;
  if ("const" in js) return js.const;
  if (Array.isArray(js.enum)) return js.enum[0];
  const union = (js.anyOf ?? js.oneOf) as JsonSchema[] | undefined;
  if (union?.[0]) return blank(union[0]);
  switch (js.type) {
    case "array":
      return [];
    case "object":
      return templateOf(js);
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    default:
      return "";
  }
}

/** Defaults filled, required fields blank, optional ones without a default left out. */
export function templateOf(schema: z.ZodType | JsonSchema): Record<string, unknown> {
  const js = schema instanceof z.ZodType ? jsonSchemaOf(schema) : schema;
  const required = new Set((js.required as string[] | undefined) ?? []);
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(props(js))) {
    if (HOST_FIELDS.has(name)) continue;
    if (required.has(name) || "default" in p) out[name] = blank(p);
  }
  return out;
}

/** One line per field, aligned: what `workflows <name>` and `site route` print. */
export function inputLines(fields: readonly InputField[]): string[] {
  if (!fields.length) return ["  (no inputs)"];
  const when = (f: InputField) =>
    f.required ? "required" : "default" in f ? `default ${short(f.default)}` : "optional";
  const w = Math.max(...fields.map((f) => f.name.length));
  const t = Math.min(40, Math.max(...fields.map((f) => f.type.length)));
  const d = Math.min(24, Math.max(...fields.map((f) => when(f).length)));
  return fields.map((f) =>
    `  ${f.name.padEnd(w)}  ${f.type.padEnd(t)}  ${when(f).padEnd(d)}  ${f.about ?? ""}`.trimEnd(),
  );
}

/** A long default (a list of permission rows) is for the template, not the table. */
const short = (v: unknown): string => {
  if (Array.isArray(v) && v.length && JSON.stringify(v).length > 16)
    return `[${v.length} item${v.length === 1 ? "" : "s"}]`;
  const s = JSON.stringify(v);
  return s.length > 16 ? `${s.slice(0, 13)}...` : s;
};
