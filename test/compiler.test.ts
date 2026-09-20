import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compile, writeRendered } from "../src/compiler/index.js";
import { polish } from "../src/compiler/polish.js";
import { render } from "../src/compiler/render.js";
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
    expect(src).toContain('gate("human"');
    expect(src).toContain("throw new NeedsHuman(");
    expect(src).toContain("irreversible: true");
    expect(src).toContain(
      'out.priceText = await fp.read({ tag: "td", role: "cell", name: "$9.77" });',
    );
    expect(src).toContain("return done(JSON.stringify(out));");
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
});

describe("compile", () => {
  it("emits a workflow and test that typecheck against the library", async () => {
    const dir = await mkdtemp(join(import.meta.dirname, ".generated-"));
    try {
      const lib = join(import.meta.dirname, "../src/index.ts");
      const out = await compile(recording, { lib });
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
  }, 60_000);
});
