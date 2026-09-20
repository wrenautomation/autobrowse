/**
 * Outline → source. Templates only: every line here is one the domain
 * workflow already has by hand, so what comes out reads like what a
 * person would write, and compiles against the library. Secrets are read
 * with `deps.secrets.get` outside `fx.run`, so they never enter the
 * journal; shell output is reduced to an exit code for the same reason.
 * The test that comes with it runs a dry run over the plan example.
 */
import { planLocator, renderLocator } from "../browser/locate.js";
import { INTERACTIVE_COMMANDS } from "../deps/shell.js";
import type { OpValue, Outline, OutlineOp, OutlineStep } from "./outline.js";
import { camel } from "./structure.js";

export interface RenderOptions {
  /** Module the generated files import the library from. */
  lib?: string;
}

export interface Rendered {
  /** Relative file name → source. */
  files: Record<string, string>;
}

const q = (s: string) => JSON.stringify(s);
const pascal = (s: string) => {
  const c = camel(s);
  return c.charAt(0).toUpperCase() + c.slice(1);
};

/** Multiline banner comment. */
function banner(lines: string[]): string {
  return `/**\n${lines.map((l) => ` * ${l}`.trimEnd()).join("\n")}\n */`;
}

function renderValue(v: OpValue): string {
  switch (v.from) {
    case "plan":
      return `input.${v.field}`;
    case "secret":
      return `input.${v.key}`;
    case "literal":
      return q(v.text);
  }
}

function renderOp(op: OutlineOp): string {
  if (op.kind === "human") return `    fp.human(${q(op.reason)});`;
  const plan = planLocator(op.hints);
  const hints = `{ ${Object.entries(op.hints)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${q(String(v))}`)
    .join(", ")} }`;
  const locatorNote = plan ? ` // ${renderLocator(plan)}` : " // TODO: no usable hints";
  const opts = `{ goal: ${q(op.goal)}${op.kind === "click" && op.irreversible ? ", irreversible: true" : ""} }`;
  const opSrc =
    op.kind === "click"
      ? `{ kind: "click" }`
      : op.kind === "fill"
        ? `{ kind: "fill", value: ${renderValue(op.value)} }`
        : op.kind === "select"
          ? `{ kind: "select", value: ${q(op.value)} }`
          : op.kind === "upload"
            ? `{ kind: "upload", files: [${renderValue(op.file)}] }`
            : `{ kind: "press", key: ${q(op.key)} }`;
  return `    await fp.act(${opSrc}, ${hints}, ${opts});${locatorNote}`;
}

/** Plan fields and secrets one flow needs, in order of first use. */
function flowInputs(step: Extract<OutlineStep, { kind: "browser" }>) {
  const fields: string[] = [];
  const secrets: string[] = [];
  for (const op of step.ops) {
    const value = op.kind === "fill" ? op.value : op.kind === "upload" ? op.file : null;
    if (!value) continue;
    if (value.from === "plan" && !fields.includes(value.field)) fields.push(value.field);
    if (value.from === "secret" && !secrets.includes(value.key)) secrets.push(value.key);
  }
  return { fields, secrets };
}

function renderBrowserStep(o: Outline, step: Extract<OutlineStep, { kind: "browser" }>): string {
  const id = camel(step.name);
  const Input = `${pascal(step.name)}Input`;
  const { fields, secrets } = flowInputs(step);
  const inputType = [...fields, ...secrets].length
    ? `export interface ${Input} {\n${[...fields, ...secrets].map((k) => `  ${k}: string;`).join("\n")}\n}`
    : `export type ${Input} = Record<string, never>;`;
  const flowLines = [
    ...(step.url ? [`    await fp.open(${q(step.url)});`] : []),
    ...step.ops.map(renderOp),
  ];
  const secretLines = secrets.map(
    (k) =>
      `    // Outside fx.run on purpose: the journal must never hold it.\n    const ${k} = await deps.secrets.get(${q(k)});`,
  );
  const inputArgs = [...fields.map((f) => `${f}: plan.${f}`), ...secrets].join(", ");
  const gate = step.irreversible
    ? `    const answer = gate("human", ${q(`Run "${step.name}" (${step.description || "irreversible"})?`)});\n    if (!answer.approved) return rejected(answer.note ?? "declined");\n`
    : "";
  const proof = step.proof
    ? `    // TODO proof: ${step.proof}`
    : "    // TODO: prove the result through an API read where one exists.";
  return `${inputType}

const ${id}Flow = defineFlow<${Input}, void>({
  site: ${q(o.site)},
  name: ${q(step.name)},
  async run(fp, input) {
${flowLines.join("\n") || "    void input;"}
  },
});

const ${id}: Step<${q(step.name)}> = {
  name: ${q(step.name)},${step.irreversible ? "\n  irreversible: true," : ""}
  async run({ fx, deps, plan${step.irreversible ? ", gate" : ""} }) {
${gate}${secretLines.length ? `${secretLines.join("\n")}\n` : ""}    await fx.run(${q(`browser ${step.name}`)}, () => deps.browser.run(${id}Flow, { ${inputArgs} }));
${proof}
    return done(${q(step.description || step.name)});
  },
};`;
}

function renderTerminalStep(step: Extract<OutlineStep, { kind: "terminal" }>): string {
  const id = camel(step.name);
  const lines = step.commands.map((cmd, i) =>
    INTERACTIVE_COMMANDS.test(cmd)
      ? `    // \`${cmd}\` is interactive; a person runs it.\n    throw new NeedsHuman(${q(`run \`${cmd}\` by hand, then play`)});`
      : `    await sh(${i}, ${q(cmd)});`,
  );
  const gate = step.irreversible
    ? `    const answer = gate("human", ${q(`Run "${step.name}" (${step.description})?`)});\n    if (!answer.approved) return rejected(answer.note ?? "declined");\n`
    : "";
  return `const ${id}: Step<${q(step.name)}> = {
  name: ${q(step.name)},${step.irreversible ? "\n  irreversible: true," : ""}
  async run({ fx, deps${step.irreversible ? ", gate" : ""} }) {
${gate}    // Only the exit code is journaled: command output can hold tokens.
    const sh = async (i: number, cmd: string) => {
      const { code } = await fx.run(\`sh \${i}\`, () => deps.shell.run(cmd).then((r) => ({ code: r.code })));
      if (code !== 0) throw new Error(\`\\\`\${cmd}\\\` exited \${code}\`);
    };
${lines.join("\n")}
    return done(${q(step.description)});
  },
};`;
}

export function render(o: Outline, opts: RenderOptions = {}): Rendered {
  const lib = opts.lib ?? "autobrowse";
  const steps = o.steps.map((s) =>
    s.kind === "browser" ? renderBrowserStep(o, s) : renderTerminalStep(s),
  );
  const needsHuman = o.steps.some(
    (s) => s.kind === "terminal" && s.commands.some((c) => INTERACTIVE_COMMANDS.test(c)),
  );
  const anyGate = o.steps.some((s) => s.irreversible);
  const anyTerminal = o.steps.some((s) => s.kind === "terminal");
  const anySecret = o.secrets.length > 0;
  const imports = [
    "defineFlow",
    "defineWorkflow",
    "done",
    "type FlowRunner",
    ...(needsHuman ? ["NeedsHuman"] : []),
    ...(anyGate ? ["rejected"] : []),
    ...(anySecret ? ["type SecretSource"] : []),
    ...(anyTerminal ? ["type Shell"] : []),
    "type StepDef",
  ].sort((a, b) => a.replace("type ", "").localeCompare(b.replace("type ", "")));

  const planFields = o.fields.map(
    (f) =>
      `  ${f.key}: z.string().min(1).describe(${q(f.label)}),${f.example ? ` // e.g. ${q(f.example)}` : ""}`,
  );
  const depFields = [
    "  browser: FlowRunner;",
    ...(anySecret ? ["  secrets: SecretSource;"] : []),
    ...(anyTerminal ? ["  shell: Shell;"] : []),
  ];

  const index = `${banner([
    `${o.description}.`,
    `Compiled from the recording ${q(o.name)}. Edit freely: the outline was the`,
    "source until this file was written; from here on this file is.",
    ...(o.secrets.length
      ? ["", `Secrets (set as env, see SecretSource): ${o.secrets.map((s) => s.key).join(", ")}.`]
      : []),
  ])}
import { ${imports.join(", ")} } from ${q(lib)};
import { z } from "zod";

export const planSchema = z.object({
  dryRun: z.boolean().default(false),
${planFields.join("\n")}
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
${depFields.join("\n")}
}

/** What steps pass forward; nothing yet. */
export type Memo = Record<string, unknown>;

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

${steps.join("\n\n")}

export const workflow = defineWorkflow<Deps, Memo>()({
  name: ${q(o.name)},
  description: ${q(o.description)},
  plan: planSchema,
  steps: [${o.steps.map((s) => camel(s.name)).join(", ")}],
  emptyMemo: () => ({}),
});
`;

  const example = o.fields.map((f) => `${f.key}: ${q(f.example ?? f.label)}`).join(", ");
  const depsSrc = [
    "browser: { run: async () => undefined as never }",
    ...(anySecret
      ? [`secrets: memorySecrets({ ${o.secrets.map((s) => `${s.key}: "x"`).join(", ")} })`]
      : []),
    ...(anyTerminal ? ["shell: fakeShell()"] : []),
  ].join(", ");
  const testImports = [
    ...(anyTerminal ? ["fakeShell"] : []),
    "memoryEffects",
    ...(anySecret ? ["memorySecrets"] : []),
    "runFlow",
  ];
  const firstIrreversible = o.steps.find((s) => s.irreversible)?.name;
  const test = `import { describe, expect, it } from "vitest";
import { ${testImports.join(", ")} } from ${q(lib)};
import { planSchema, workflow } from "./index.js";

const deps = () => ({ ${depsSrc} });

describe(${q(o.name)}, () => {
  it("parses the recorded example", () => {
    expect(planSchema.parse({ ${example} }).dryRun).toBe(false);
  });

  it("dry run plans and stops before anything irreversible", async () => {
    const plan = planSchema.parse({ dryRun: true, ${example} });
    const out = await runFlow(memoryEffects().fx, workflow, deps(), plan);
${
  firstIrreversible
    ? `    expect(out.status).toBe("planned");
    expect(out.results[${q(firstIrreversible)}]?.status).toBe("planned");`
    : `    expect(out.status).toBe("done");`
}
  });
});
`;
  return { files: { "index.ts": index, "index.test.ts": test } };
}
