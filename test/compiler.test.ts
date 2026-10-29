import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compile, writeRendered } from "../src/compiler/index.js";
import { lintFiles, lintText } from "../src/compiler/lint.js";
import { outlineSchema } from "../src/compiler/outline.js";
import { polish } from "../src/compiler/polish.js";
import { render, renderOp } from "../src/compiler/render.js";
import { structure } from "../src/compiler/structure.js";
import { fakeLlm } from "../src/llm/fake.js";
import type { LocatorHints, Recording } from "../src/recorder/types.js";

const h = (p: Partial<LocatorHints>): LocatorHints => ({
  tag: "input",
  role: null,
  name: null,
  text: null,
  placeholder: null,
  id: null,
  testId: null,
  href: null,
  inputType: null,
  ...p,
});

/** A domain purchase as the recorder would see it: search, pause for 2FA, buy, then a shell leg. */
const recording: Recording = {
  name: "buy-domain",
  site: "cloudflare",
  startedAt: "2026-09-19T10:00:00Z",
  finishedAt: "2026-09-19T10:05:00Z",
  trace: null,
  terminal: "terminal.log",
  commands: ["gh auth login", "gh secret set X --body y"],
  actions: [
    { t: 0, kind: "navigate", url: "https://dash.cloudflare.com/register" },
    {
      t: 1,
      kind: "input",
      url: "https://dash.cloudflare.com/register",
      target: h({ role: "textbox", name: "Domain" }),
      value: "wren-six.com",
      redacted: false,
    },
    {
      t: 2,
      kind: "press",
      url: "https://dash.cloudflare.com/register",
      target: h({ role: "textbox", name: "Domain" }),
      key: "Enter",
    },
    { t: 3, kind: "navigate", url: "https://dash.cloudflare.com/results?q=x" },
    {
      t: 3.5,
      kind: "read",
      url: "https://dash.cloudflare.com/results?q=x",
      target: h({ tag: "td", role: "cell", name: "$9.77" }),
      as: "priceText",
      value: "$9.77",
    },
    { t: 4, kind: "note", url: "https://dash.cloudflare.com/results?q=x", text: "Checkout" },
    {
      t: 5,
      kind: "input",
      url: "https://dash.cloudflare.com/results?q=x",
      target: h({ role: "textbox", name: "Card CVV", inputType: "password" }),
      value: "<redacted>",
      redacted: true,
    },
    { t: 6, kind: "pause", url: "https://dash.cloudflare.com/results?q=x" },
    { t: 7, kind: "resume", url: "https://dash.cloudflare.com/results?q=x" },
    {
      t: 8,
      kind: "click",
      url: "https://dash.cloudflare.com/results?q=x",
      target: h({
        tag: "button",
        role: "button",
        name: "Complete purchase",
        text: "Complete purchase",
      }),
    },
    {
      t: 9,
      kind: "submit",
      url: "https://dash.cloudflare.com/results?q=x",
      target: h({ tag: "form" }),
    },
  ],
};

describe("structure", () => {
  it("splits steps at navigations and notes, types inputs, flags irreversible clicks and pauses", () => {
    const o = structure(recording);
    expect(o.steps.map((s) => [s.name, s.kind, s.irreversible])).toEqual([
      ["register", "browser", false],
      ["results", "browser", false],
      ["checkout", "browser", true],
      ["terminal", "terminal", false],
    ]);
    const results = o.steps[1];
    if (results?.kind !== "browser") throw new Error("expected browser step");
    expect(results.ops).toEqual([
      { kind: "read", goal: "read $9.77 as priceText", hints: expect.anything(), as: "priceText" },
    ]);
    expect(o.fields).toEqual([{ key: "domain", label: "Domain", example: "wren-six.com" }]);
    expect(o.secrets).toEqual([{ key: "cardCvv", label: "Card CVV" }]);
    const checkout = o.steps[2];
    if (checkout?.kind !== "browser") throw new Error("expected browser step");
    expect(checkout.url).toBe("https://dash.cloudflare.com/results?q=x");
    expect(checkout.ops.map((op) => op.kind)).toEqual(["fill", "human", "click"]);
    expect(checkout.description).toBe("Checkout");
    const terminal = o.steps[3];
    if (terminal?.kind !== "terminal") throw new Error("expected terminal step");
    expect(terminal.description).toMatch(/1 need a person \(gh auth login\)/);
  });
});

describe("render", () => {
  it("keeps secrets out of fx.run and journals only exit codes", () => {
    const { files } = render(structure(recording));
    const src = files["index.ts"] ?? "";
    expect(src).toContain('const cardCvv = await deps.secrets.get("cardCvv");');
    expect(src).not.toMatch(/fx\.run\([^)]*secrets/);
    expect(src).toContain("({ code: r.code })");
    expect(src).toContain('gate("send"');
    expect(src).toContain("throw new NeedsHuman(");
    expect(src).toContain("irreversible: true");
    expect(src).toContain(
      'out.priceText = await fp.read({ tag: "td", role: "cell", name: "$9.77" });',
    );
    expect(src).toContain("return done(JSON.stringify(out));");
  });

  it("keeps a read's regex group, and nothing when it does not match", () => {
    const line = renderOp({
      kind: "read",
      goal: "read the price",
      hints: { role: "cell", name: "$9.77" },
      as: "price",
      match: "\\$([\\d.]+)",
    });
    expect(line).toContain(
      '.match(new RegExp("\\\\$([\\\\d.]+)", "i")); if (m) out.price = m[1] ?? m[0];',
    );
  });
});

describe("records", () => {
  /** A search typed on the home page, then a list read on the results page the search led to. */
  const rec: Recording = {
    ...recording,
    name: "search-list",
    commands: [],
    terminal: null,
    actions: [
      { t: 0, kind: "navigate", url: "https://s.test/" },
      {
        t: 1,
        kind: "input",
        url: "https://s.test/",
        target: h({ role: "searchbox", name: "Search" }),
        value: "web scraping",
        redacted: false,
      },
      {
        t: 2,
        kind: "note",
        url: "https://s.test/?q=web%20scraping&sort=top",
        text: "Read the stories.",
      },
      {
        t: 3,
        kind: "records",
        url: "https://s.test/?q=web%20scraping&sort=top",
        op: {
          kind: "records",
          goal: "the stories",
          as: "stories",
          fields: [{ key: "title", says: "its title" }],
          key: "title",
          code: "return [...root.querySelectorAll('h2')].map((h) => ({ title: h.textContent }));",
          min: 2,
          sample: [{ title: "A" }],
        },
      },
    ],
  };

  it("renders a list read as its checked code, on the page the step started, the query encoded", async () => {
    const out = await compile(rec);
    const src = out.files["index.ts"] ?? "";
    const step = out.outline.steps[1];
    if (step?.kind !== "browser") throw new Error("browser step expected");
    const field = out.outline.fields[0]?.key as string;
    expect(step.url).toBe(`https://s.test/?q={${field}}&sort=top`);
    expect(src).toContain(`?q=\${encodeURIComponent(input.${field})}&sort=top`);
    expect(src).toContain("out.stories = await records(fp, {");
    expect(src).toContain("code: `return [...root.querySelectorAll('h2')]");
    expect(src).toContain("const out: Record<string, unknown> = {};");
    expect(src).not.toContain("web scraping");
  });

  it("keeps code a template cannot hold as a string", () => {
    const line = renderOp({
      ...(rec.actions[3] as { op: Extract<Parameters<typeof renderOp>[0], { kind: "records" }> })
        .op,
      code: "return [`a`].map((title) => ({ title }));",
    });
    expect(line).toContain('code: "return [`a`].map((title) => ({ title }));"');
  });
});

describe("keep", () => {
  it("renders a minted secret through the input sink, never the journaled result", () => {
    const rec: Recording = {
      ...recording,
      name: "mint-key",
      commands: [],
      terminal: null,
      actions: [
        { t: 0, kind: "navigate", url: "https://x.test/keys" },
        {
          t: 1,
          kind: "click",
          url: "https://x.test/keys",
          target: h({ tag: "button", role: "button", name: "Create key" }),
        },
        {
          t: 2,
          kind: "keep",
          url: "https://x.test/keys",
          target: { ...h({ tag: "p", role: null, name: null }), css: "[role=dialog] p", nth: 1 },
          env: "X_API_KEY",
        },
      ],
    };
    const o = structure(rec);
    expect(o.steps[0]?.kind === "browser" && o.steps[0].ops.at(-1)).toMatchObject({
      kind: "keep",
      env: "X_API_KEY",
    });
    const src = render(o).files["index.ts"] ?? "";
    // Numbers stay numbers: `nth: "1"` would not typecheck against the locator hints.
    expect(src).toContain(
      'await input.sink.put("X_API_KEY", await fp.read({ tag: "p", css: "[role=dialog] p", nth: 1 }));',
    );
    expect(src).toContain("sink: SecretSink;");
    expect(src).toContain("{ sink: deps.sink }");
    expect(src).not.toContain("JSON.stringify(out)");
  });
});

describe("url fields", () => {
  it("a {field} in a step url is a plan field: templated, declared, and refused when it is not", () => {
    const o = structure({
      ...recording,
      name: "open-project",
      commands: [],
      terminal: null,
      actions: [
        { t: 0, kind: "navigate", url: "https://x.test/apis?project=p1" },
        {
          t: 1,
          kind: "click",
          url: "https://x.test/apis?project=p1",
          target: h({ role: "button", name: "Enable" }),
        },
      ],
    });
    const step = o.steps[0];
    if (step?.kind !== "browser") throw new Error("browser step expected");
    step.url = "https://x.test/apis?project={project}";
    o.fields.push({ key: "project", label: "Project id", example: "p1" });
    const src = render(o).files["index.ts"] ?? "";
    expect(src).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the generated source, not a template here
      "await fp.open(`https://x.test/apis?project=${encodeURIComponent(input.project)}`);",
    );
    expect(src).toContain("project: plan.project");
    expect(src).toContain("  project: string;");
    expect(() => outlineSchema.parse({ ...o, fields: [] })).toThrow(/\{project\}/);
  });
});

describe("operator defaults", () => {
  /** A signup that types a handle, then clicks the page's "<handle> Instagram" heading as the account. */
  const rec: Recording = {
    ...recording,
    name: "signup-x",
    commands: [],
    terminal: null,
    actions: [
      { t: 0, kind: "navigate", url: "https://x.test/signup" },
      {
        t: 1,
        kind: "input",
        url: "https://x.test/signup",
        target: h({ name: "Handle" }),
        value: "acmeco",
        redacted: false,
      },
      {
        t: 2,
        kind: "input",
        url: "https://x.test/signup",
        target: h({ name: "Email" }),
        value: "me@example.com",
        redacted: false,
      },
      { t: 3, kind: "navigate", url: "https://x.test/acmeco/home" },
      {
        t: 4,
        kind: "click",
        url: "https://x.test/acmeco/home",
        target: h({ tag: "a", role: "link", name: "acmeco Instagram" }),
      },
      {
        t: 5,
        kind: "click",
        url: "https://x.test/acmeco/home",
        target: h({ tag: "button", role: "button", name: "me@example.com menu" }),
      },
    ],
  };
  const known = [{ value: "me@example.com", kind: "account" }];

  it("a typed value or the account in a URL or hint becomes {field}; the plan file keeps the values", async () => {
    const out = await compile(rec, { known });
    const src = out.files["index.ts"] ?? "";
    const step = out.outline.steps[1];
    if (step?.kind !== "browser") throw new Error("browser step expected");
    const handle = out.outline.fields.find((f) => /handle/i.test(f.label))?.key as string;
    const email = out.outline.fields.find((f) => /email/i.test(f.label))?.key as string;
    expect(step.url).toBe(`https://x.test/{${handle}}/home`);
    expect(step.ops.map((op) => ("hints" in op ? op.hints.name : null))).toEqual([
      `{${handle}} Instagram`,
      `{${email}} menu`,
    ]);
    // Every typed value lands in the defaults and leaves the outline: the module names no one.
    expect(out.defaults).toEqual({ [handle]: "acmeco", [email]: "me@example.com" });
    expect(out.outline.fields.map((f) => f.example)).toEqual([null, null]);
    expect(src).not.toContain("acmeco");
    expect(src).not.toContain("me@example.com");
    expect(out.lint).toEqual([]);
    expect(src).toContain(`name: \`\${input.${handle}} Instagram\``);
  });

  it("the lint names the place and the kind of personal data left, never the value", () => {
    const hits = lintFiles(
      {
        "index.ts": 'const a = "me@acme.io";\nconst b = "acmeco";',
        "index.test.ts": '"x@acme.io"',
      },
      [{ value: "acmeco", kind: "account" }],
      { knownOnly: ["index.test.ts"] },
    );
    expect(hits).toEqual([
      { file: "index.ts", line: 1, kind: "email" },
      { file: "index.ts", line: 2, kind: "known:account" },
    ]);
    expect(lintText("see 203.0.113.7, you@example.com, Chrome/129.0.0.0")).toEqual([]);
  });
});

describe("billing", () => {
  it("makes a step that fills a card field wait for the person, whatever it clicks", () => {
    const rec: Recording = {
      ...recording,
      name: "pay",
      commands: [],
      terminal: null,
      actions: [
        { t: 0, kind: "navigate", url: "https://x.test/billing" },
        {
          t: 1,
          kind: "input",
          url: "https://x.test/billing",
          target: h({ tag: "input", role: "textbox", name: "Card number" }),
          value: "<redacted>",
          redacted: true,
        },
        {
          t: 2,
          kind: "click",
          url: "https://x.test/billing",
          target: h({ tag: "button", role: "button", name: "Continue" }),
        },
      ],
    };
    const o = structure(rec);
    expect(o.steps[0]?.irreversible).toBe(true);
    expect(o.secrets.map((s) => s.key)).toEqual(["cardNumber"]);
  });
});

describe("polish", () => {
  it("applies names, descriptions, proofs and irreversible upgrades only", async () => {
    const o = structure(recording);
    const llm = fakeLlm([
      {
        description: "Buy a domain at Cloudflare",
        steps: [
          { index: 0, name: "Search Domain", proof: "registrar API lists it" },
          { index: 2, irreversible: false, name: "search-domain" },
          { index: 9, name: "ghost" },
        ],
      },
    ]);
    const { outline } = await polish(o, llm);
    expect(outline.description).toBe("Buy a domain at Cloudflare");
    expect(outline.steps[0]?.name).toBe("search-domain");
    expect(outline.steps[0]?.proof).toBe("registrar API lists it");
    expect(outline.steps[2]?.name).toBe("checkout"); // collision kept the old name
    expect(outline.steps[2]?.irreversible).toBe(true); // never downgraded
    expect(outline.steps).toHaveLength(4);
  });
  it("renames an opaque plan field everywhere it is read, never onto a taken or bad key", async () => {
    const o = structure(recording);
    o.fields.push({ key: "field1", label: "field1", example: "p1" });
    const step = o.steps[0];
    if (step?.kind !== "browser") throw new Error("expected a browser step");
    step.url = "https://x.test/{field1}";
    step.ops.push({
      kind: "fill",
      goal: "fill field1",
      hints: { role: "textbox" },
      value: { from: "plan", field: "field1" },
    });
    const llm = fakeLlm([
      {
        fields: [
          { key: "field1", name: "Project Id" },
          { key: "domain", name: "project-id" },
          { key: "ghost", name: "x" },
          { key: "cardCvv", name: "1bad" },
        ],
        steps: [],
      },
    ]);
    const { outline } = await polish(o, llm);
    expect(outline.fields.map((f) => f.key)).toEqual(["domain", "projectId"]);
    const first = outline.steps[0];
    if (first?.kind !== "browser") throw new Error("expected a browser step");
    expect(first.url).toBe("https://x.test/{projectId}");
    expect(first.ops.at(-1)).toMatchObject({ value: { from: "plan", field: "projectId" } });
    expect(
      first.ops.find(
        (op) => op.kind === "fill" && op.value.from === "plan" && op.value.field === "domain",
      ),
    ).toBeDefined();
    expect(() => outlineSchema.parse(outline)).not.toThrow();
  });
});

/** The agent's code row, as explore journals it: a loop over pages, its plan as given. */
const coded: Recording = {
  ...recording,
  name: "pages-loop",
  commands: [],
  terminal: null,
  actions: [
    { t: 0, kind: "navigate", url: "https://s.test/" },
    {
      t: 1,
      kind: "code",
      url: "https://s.test/",
      as: "titles",
      plan: { pages: "3" },
      code: 'for (let p = 1; p <= Number(plan.pages); p++) {\n  await fp.open("https://s.test/" + p);\n  rows.push({ p, title: await fp.read({ css: "h1" }) });\n}',
    },
  ],
};

describe("code", () => {
  it("renders the agent's code as runCode, its plan a plan field", async () => {
    const out = await compile(coded);
    const src = out.files["index.ts"] ?? "";
    // The example goes to the operator's defaults, as a typed value does.
    expect(out.outline.fields).toEqual([
      { key: "pages", label: "pages for the code", example: null },
    ]);
    expect(src).toContain(
      "out.titles = (await runCode(fp, { plan: { pages: input.pages }, code: `for",
    );
    expect(src).toMatch(/import \{[^}]*runCode/);
    expect(src).toContain("pages: z.string()");
  });
});

describe("compile", () => {
  it.each([
    ["a recording", recording],
    ["a code row", coded],
  ])(
    "emits a workflow and test that typecheck against the library (%s)",
    async (_, rec) => {
      const dir = await mkdtemp(join(import.meta.dirname, ".generated-"));
      try {
        const lib = join(import.meta.dirname, "../src/index.ts");
        const out = await compile(rec, { lib });
        const files = await writeRendered(dir, out);
        const config = ts.readConfigFile(
          join(import.meta.dirname, "../tsconfig.json"),
          ts.sys.readFile,
        );
        const parsed = ts.parseJsonConfigFileContent(
          config.config,
          ts.sys,
          join(import.meta.dirname, ".."),
        );
        const program = ts.createProgram(files, {
          ...parsed.options,
          noEmit: true,
          allowImportingTsExtensions: true,
          types: ["node"],
        });
        const diagnostics = ts
          .getPreEmitDiagnostics(program)
          .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
        expect(diagnostics).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
