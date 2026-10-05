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
import type { DesktopOutlineOp, OpValue, Outline, OutlineOp, OutlineStep } from "./outline.js";
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

/** One op as one statement, indented for a flow's body. */
export function renderOp(op: OutlineOp): string {
  if (op.kind === "human") return `    fp.human(${q(op.reason)});`;
  if (op.kind === "records" || op.kind === "ai")
    throw new Error(`a ${op.kind} op runs in a walk; compile does not render it (${op.goal})`);
  const plan = planLocator(op.hints);
  const hints = `{ ${Object.entries(op.hints)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${typeof v === "number" ? v : q(String(v))}`)
    .join(", ")} }`;
  const locatorNote = plan ? ` // ${renderLocator(plan)}` : " // TODO: no usable hints";
  if (op.kind === "read") return `    out.${op.as} = await fp.read(${hints});${locatorNote}`;
  // Through the input, not the result: the flow's return value is journaled, the sink is not.
  if (op.kind === "keep")
    return `    await input.sink.put(${q(op.env)}, await fp.read(${hints}));${locatorNote}`;
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

/** `{project}` in a step URL is the plan field `project`. */
export const URL_FIELD = /\{([a-z][a-zA-Z0-9]*)\}/g;

/** A step URL as source: a plain string, or a template when it names plan fields. */
function renderUrl(url: string): string {
  if (!URL_FIELD.test(url)) return q(url);
  URL_FIELD.lastIndex = 0;
  const body = url
    .replace(/[`\\]/g, "\\$&")
    .replace(/\$\{/g, "\\${")
    .replace(URL_FIELD, (_m, f: string) => `\${encodeURIComponent(input.${f})}`);
  return `\`${body}\``;
}

/** Plan fields and secrets one flow needs, in order of first use. */
export function flowInputs(step: Extract<OutlineStep, { kind: "browser" }>) {
  const fields: string[] = [];
  const secrets: string[] = [];
  for (const m of (step.url ?? "").matchAll(URL_FIELD)) {
    const f = m[1] as string;
    if (!fields.includes(f)) fields.push(f);
  }
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
  const keeps = step.ops.some((op) => op.kind === "keep");
  const inputLines = [
    ...[...fields, ...secrets].map((k) => `  ${k}: string;`),
    ...(keeps ? ["  sink: SecretSink;"] : []),
  ];
  const inputType = inputLines.length
    ? `export interface ${Input} {\n${inputLines.join("\n")}\n}`
    : `export type ${Input} = Record<string, never>;`;
  const reads = step.ops.filter((op) => op.kind === "read");
  const flowLines = [
    ...(step.url ? [`    await fp.open(${renderUrl(step.url)});`] : []),
    ...(reads.length ? ["    const out: Record<string, string> = {};"] : []),
    ...step.ops.map(renderOp),
    ...(reads.length ? ["    return out;"] : []),
  ];
  const secretLines = secrets.map(
    (k) =>
      `    // Outside fx.run on purpose: the journal must never hold it.\n    const ${k} = await deps.secrets.get(${q(k)});`,
  );
  const inputArgs = [
    ...fields.map((f) => `${f}: plan.${f}`),
    ...secrets,
    ...(keeps ? ["sink: deps.sink"] : []),
  ].join(", ");
  const gate = step.irreversible
    ? `    const answer = gate("send", ${q(`Run "${step.name}" (${step.description || "irreversible"})?`)});\n    if (!answer.approved) return rejected(answer.note ?? "declined");\n`
    : "";
  const proof = step.proof
    ? `    // TODO proof: ${step.proof}`
    : "    // TODO: prove the result through an API read where one exists.";
  return `${inputType}

const ${id}Flow = defineFlow<${Input}, ${reads.length ? "Record<string, string>" : "void"}>({
  site: ${q(o.site)},
  name: ${q(step.name)},
  async run(fp${inputArgs ? ", input" : ""}) {
${flowLines.join("\n") || "    void fp;"}
  },
});

const ${id}: Step<${q(step.name)}> = {
  name: ${q(step.name)},${step.irreversible ? "\n  irreversible: true," : ""}
  async run({ fx, deps${fields.length ? ", plan" : ""}${step.irreversible ? ", gate" : ""} }) {
${gate}${secretLines.length ? `${secretLines.join("\n")}\n` : ""}    ${reads.length ? "const out = " : ""}await fx.run(${q(`browser ${step.name}`)}, () => deps.browser.run(${id}Flow, { ${inputArgs} }));
${proof}
    return done(${reads.length ? "JSON.stringify(out)" : q(step.description || step.name)});
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
    ? `    const answer = gate("send", ${q(`Run "${step.name}" (${step.description})?`)});\n    if (!answer.approved) return rejected(answer.note ?? "declined");\n`
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

/** A typed value in a desktop step: plan fields off the plan, secrets fetched outside the journal. */
function renderDesktopValue(v: OpValue): string {
  switch (v.from) {
    case "plan":
      return `plan.${v.field}`;
    case "secret":
      return v.key;
    case "literal":
      return q(v.text);
  }
}

function renderDesktopOp(op: DesktopOutlineOp, i: number): string {
  const act = (src: string) =>
    `    await fx.run(${q(`desktop ${i} ${op.kind}`)}, () => ${src}); // ${op.goal}`;
  switch (op.kind) {
    case "open":
      return act(`deps.desktop.open(${q(op.app)})`);
    case "click":
      return act(
        `deps.desktop.click({ ${[
          ...(op.app ? [`app: ${q(op.app)}`] : []),
          ...(op.role ? [`role: ${q(op.role)}`] : []),
          `name: ${q(op.name)}`,
        ].join(", ")} })`,
      );
    case "type":
      // The journal keeps only that the step ran, never what was typed.
      return act(`deps.desktop.type(${renderDesktopValue(op.value)}).then(() => undefined)`);
    case "key":
      return act(`deps.desktop.key(${q(op.combo)})`);
    case "shell":
      return `    await sh(${i}, ${q(op.command)}${op.root ? ", true" : ""}); // ${op.goal}`;
    case "wait":
      return `    await fx.sleep(${op.ms});`;
  }
}

function renderDesktopStep(step: Extract<OutlineStep, { kind: "desktop" }>): string {
  const id = camel(step.name);
  const secrets = [
    ...new Set(
      step.ops.flatMap((op) =>
        op.kind === "type" && op.value.from === "secret" ? [op.value.key] : [],
      ),
    ),
  ];
  const usesPlan = step.ops.some((op) => op.kind === "type" && op.value.from === "plan");
  const anyShell = step.ops.some((op) => op.kind === "shell");
  const gate = step.irreversible
    ? `    const answer = gate("send", ${q(`Run "${step.name}" (${step.description || "irreversible"})?`)});\n    if (!answer.approved) return rejected(answer.note ?? "declined");\n`
    : "";
  const secretLines = secrets.map(
    (k) =>
      `    // Outside fx.run on purpose: the journal must never hold it.\n    const ${k} = await deps.secrets.get(${q(k)});`,
  );
  const shell = anyShell
    ? `    // Only the exit code is journaled: command output can hold tokens.
    const sh = async (i: number, cmd: string, root = false) => {
      const { code } = await fx.run(\`desktop \${i} shell\`, () => deps.desktop.shell(cmd, root).then((r) => ({ code: r.code })));
      if (code !== 0) throw new Error(\`\\\`\${cmd}\\\` exited \${code}\`);
    };
`
    : "";
  const ctx = ["fx", "deps", ...(usesPlan ? ["plan"] : []), ...(step.irreversible ? ["gate"] : [])];
  return `const ${id}: Step<${q(step.name)}> = {
  name: ${q(step.name)},${step.irreversible ? "\n  irreversible: true," : ""}
  async run({ ${ctx.join(", ")} }) {
${gate}${secretLines.length ? `${secretLines.join("\n")}\n` : ""}${shell}${step.ops.map(renderDesktopOp).join("\n")}
    return done(${q(step.description || step.name)});
  },
};`;
}

export function render(o: Outline, opts: RenderOptions = {}): Rendered {
  const lib = opts.lib ?? "autobrowse";
  const steps = o.steps.map((s) =>
    s.kind === "browser"
      ? renderBrowserStep(o, s)
      : s.kind === "terminal"
        ? renderTerminalStep(s)
        : renderDesktopStep(s),
  );
  const needsHuman = o.steps.some(
    (s) => s.kind === "terminal" && s.commands.some((c) => INTERACTIVE_COMMANDS.test(c)),
  );
  const anyGate = o.steps.some((s) => s.irreversible);
  const anyTerminal = o.steps.some((s) => s.kind === "terminal");
  const anyDesktop = o.steps.some((s) => s.kind === "desktop");
  const anyKeep = o.steps.some(
    (s) => s.kind === "browser" && s.ops.some((op) => op.kind === "keep"),
  );
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
    ...(anyDesktop ? ["type Desktop"] : []),
    ...(anyKeep ? ["type SecretSink"] : []),
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
    ...(anyDesktop ? ["  desktop: Desktop;"] : []),
    ...(anyKeep ? ["  sink: SecretSink;"] : []),
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
    ...(anyDesktop ? ["desktop: fakeDesktop()"] : []),
    ...(anyKeep ? ["sink: memorySink()"] : []),
  ].join(", ");
  const testImports = [
    ...(anyDesktop ? ["fakeDesktop"] : []),
    ...(anyKeep ? ["memorySink"] : []),
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
