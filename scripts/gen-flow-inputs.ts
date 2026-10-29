/**
 * Writes src/browser/flows/inputs.gen.ts: each hand-written flow's input type as a zod schema,
 * read with the TypeScript checker. `pnpm gen:flow-inputs` after a flow's input changes;
 * typecheck fails until then (each entry is held to its flow's input type).
 */
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dirname, "..");
const DIR = join(ROOT, "src/browser/flows");
const OUT = join(DIR, "inputs.gen.ts");

const config = ts.getParsedCommandLineOfConfigFile(
  join(ROOT, "tsconfig.json"),
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    },
  },
);
if (!config) throw new Error("no tsconfig");
const files = config.fileNames.filter(
  (f) => f.startsWith(DIR) && !f.endsWith(".test.ts") && !f.endsWith(".gen.ts"),
);
const program = ts.createProgram(files, config.options);
const checker = program.getTypeChecker();

/** Not JSON (a function, a class instance): the flow takes it from code, never from an agent. */
let data = true;

function zodOf(t: ts.Type, depth = 0): string {
  if (depth > 8) return "z.unknown()";
  const f = t.flags;
  if (f & ts.TypeFlags.Any || f & ts.TypeFlags.Unknown) return "z.unknown()";
  if (f & ts.TypeFlags.Undefined || f & ts.TypeFlags.Void) return "z.undefined()";
  if (f & ts.TypeFlags.Null) return "z.null()";
  if (f & ts.TypeFlags.Never) return "z.never()";
  if (f & ts.TypeFlags.StringLiteral)
    return `z.literal(${JSON.stringify((t as ts.StringLiteralType).value)})`;
  if (f & ts.TypeFlags.NumberLiteral) return `z.literal(${(t as ts.NumberLiteralType).value})`;
  if (f & ts.TypeFlags.BooleanLiteral) return `z.literal(${checker.typeToString(t)})`;
  if (f & ts.TypeFlags.String) return "z.string()";
  if (f & ts.TypeFlags.Number) return "z.number()";
  if (f & ts.TypeFlags.Boolean) return "z.boolean()";
  if (t.isUnion()) {
    const parts = t.types.filter((p) => !(p.flags & ts.TypeFlags.Undefined));
    const opt = parts.length < t.types.length;
    // `true | false` is boolean
    const bools = parts.filter((p) => p.flags & ts.TypeFlags.BooleanLiteral);
    const rest = parts.filter((p) => !(p.flags & ts.TypeFlags.BooleanLiteral));
    const members = [
      ...(bools.length === 2 ? ["z.boolean()"] : bools.map((b) => zodOf(b, depth + 1))),
      ...rest.map((p) => zodOf(p, depth + 1)),
    ];
    const one = members.length === 1 ? members[0] : `z.union([${members.join(", ")}])`;
    return opt ? `${one}.optional()` : (one ?? "z.never()");
  }
  if (checker.isArrayType(t)) {
    const [el] = checker.getTypeArguments(t as ts.TypeReference);
    return `z.array(${el ? zodOf(el, depth + 1) : "z.unknown()"})`;
  }
  if (checker.isTupleType(t))
    return `z.tuple([${checker
      .getTypeArguments(t as ts.TypeReference)
      .map((e) => zodOf(e, depth + 1))
      .join(", ")}])`;
  if (t.getCallSignatures().length > 0) {
    data = false;
    return "z.custom<never>(() => true)";
  }
  if (f & ts.TypeFlags.Object || t.isIntersection()) {
    const sym = t.getSymbol();
    // A hint's name may be a pattern: code passes one, an agent sends the string.
    if (sym?.name === "RegExp") return "z.instanceof(RegExp)";
    // Class instances and built-ins (Date, Buffer, a sink) are code, not data.
    if (
      sym &&
      (sym.flags & ts.SymbolFlags.Class ||
        ["Date", "Buffer", "Uint8Array", "Map", "Set"].includes(sym.name))
    ) {
      data = false;
      return "z.custom<never>(() => true)";
    }
    const index = checker.getIndexInfoOfType(t, ts.IndexKind.String);
    const props = checker.getPropertiesOfType(t);
    if (index && props.length === 0) return `z.record(z.string(), ${zodOf(index.type, depth + 1)})`;
    const fields = props.flatMap((p) => {
      const pt = checker.getTypeOfSymbol(p);
      const optional = (p.flags & ts.SymbolFlags.Optional) !== 0;
      const was = data;
      data = true;
      let z = zodOf(pt, depth + 1);
      const plain = data;
      // An optional field only code passes (a sink): left out, so the input stays JSON.
      data = was && (plain || optional);
      if (optional && !plain) return [];
      if (optional && !z.endsWith(".optional()")) z += ".optional()";
      const key = /^[A-Za-z_$][\w$]*$/.test(p.name) ? p.name : JSON.stringify(p.name);
      return [`${key}: ${z}`];
    });
    return `z.object({ ${fields.join(", ")} })`;
  }
  return "z.unknown()";
}

interface Entry {
  file: string;
  name: string;
  schema: string;
  data: boolean;
}
const entries: Entry[] = [];
for (const file of files) {
  const src = program.getSourceFile(file);
  if (!src) continue;
  const mod = checker.getSymbolAtLocation(src);
  if (!mod) continue;
  for (const sym of checker.getExportsOfModule(mod)) {
    if (!(sym.flags & ts.SymbolFlags.Variable)) continue;
    const t = checker.getTypeOfSymbol(sym);
    const run = t.getProperty("run");
    if (!run || !t.getProperty("site") || !t.getProperty("name")) continue;
    const [sig] = checker.getTypeOfSymbol(run).getCallSignatures();
    const param = sig?.getParameters()[1];
    if (sig?.getParameters()[0]?.name !== "fp") continue;
    data = true;
    const schema = param ? zodOf(checker.getTypeOfSymbol(param)) : "z.undefined()";
    entries.push({ file: basename(file, ".ts"), name: sym.name, schema, data });
  }
}
entries.sort((a, b) => a.name.localeCompare(b.name));

const byFile = new Map<string, string[]>();
for (const e of entries) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e.name]);
const imports = [...byFile]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([f, names]) => `import { ${names.join(", ")} } from "./${f}.js";`);

const out = `// Generated by scripts/gen-flow-inputs.ts from each flow's input type. Do not edit.
import { z } from "zod";
import type { BrowserFlow } from "../flow.js";
${imports.join("\n")}

/** \`data\`: the input is plain JSON, so an agent can send it; false = code passes it (a sink, a function). */
export interface FlowInput {
  flow: BrowserFlow<never, unknown>;
  input: z.ZodType;
  data: boolean;
}
/** Held to the flow's own input type: a changed input fails typecheck until this file is made again. */
const entry = <I>(flow: BrowserFlow<I, unknown>, input: z.ZodType<I>, data: boolean): FlowInput => ({
  flow: flow as BrowserFlow<never, unknown>,
  input,
  data,
});

export const FLOW_INPUTS: readonly FlowInput[] = [
${entries.map((e) => `  entry(${e.name}, ${e.schema}, ${e.data}),`).join("\n")}
];
`;
writeFileSync(OUT, out);
console.log(`${entries.length} flows, ${entries.filter((e) => !e.data).length} take code`);
