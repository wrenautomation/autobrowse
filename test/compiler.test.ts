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
      ["checkout", "browser", true],
      ["terminal", "terminal", false],
    ]);
    expect(o.fields).toEqual([{ key: "domain", label: "Domain", example: "wren-six.com" }]);
    expect(o.secrets).toEqual([{ key: "cardCvv", label: "Card CVV" }]);
    const checkout = o.steps[1];
    if (checkout?.kind !== "browser") throw new Error("expected browser step");
    expect(checkout.url).toBe("https://dash.cloudflare.com/results?q=x");
    expect(checkout.ops.map((op) => op.kind)).toEqual(["fill", "human", "click"]);
    expect(checkout.description).toBe("Checkout");
    const terminal = o.steps[2];
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
          { index: 1, irreversible: false, name: "search-domain" },
          { index: 9, name: "ghost" },
        ],
      },
    ]);
    const { outline } = await polish(o, llm);
    expect(outline.description).toBe("Buy a domain at Cloudflare");
    expect(outline.steps[0]?.name).toBe("search-domain");
    expect(outline.steps[0]?.proof).toBe("registrar API lists it");
    expect(outline.steps[1]?.name).toBe("checkout"); // collision kept the old name
    expect(outline.steps[1]?.irreversible).toBe(true); // never downgraded
    expect(outline.steps).toHaveLength(3);
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
