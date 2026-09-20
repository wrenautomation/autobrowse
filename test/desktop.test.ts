import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compile, writeRendered } from "../src/compiler/index.js";
import { render } from "../src/compiler/render.js";
import { structure } from "../src/compiler/structure.js";
import { describeOp } from "../src/desktop/describe.js";
import {
  KEY_CODES,
  macDesktop,
  parseCombo,
  ROOT_HELPER,
  rootHelper,
  rootSetupCommands,
  sudoersLine,
} from "../src/desktop/mac.js";
import { fakeDesktop, noDesktop, treeText } from "../src/desktop/types.js";
import type { Recording } from "../src/recorder/types.js";

describe("key combos", () => {
  it("maps names to key codes and letters to keystrokes, modifiers to System Events words", () => {
    expect(parseCombo("cmd+shift+4")).toEqual({
      key: "4",
      code: null,
      using: ["command down", "shift down"],
    });
    expect(parseCombo("Return")).toEqual({ key: null, code: KEY_CODES.return, using: [] });
    expect(parseCombo("ctrl+left")).toEqual({ key: null, code: 123, using: ["control down"] });
    expect(() => parseCombo("hyper+x")).toThrow(/unknown modifier/);
    expect(() => parseCombo("cmd+F13")).toThrow(/unknown key/);
  });
});

describe("mac desktop", () => {
  /** A scripted `osascript`: records every call, answers by script name. */
  function scripted(answers: Record<string, string | { code: number; stderr: string }> = {}) {
    const calls: Array<{ file: string; args: string[] }> = [];
    const d = macDesktop({
      run: async (file, args) => {
        calls.push({ file, args });
        const script = args[3] ?? "";
        const key = Object.keys(answers).find((k) => script.includes(k)) ?? "";
        const a = answers[key];
        if (a === undefined) return { code: 0, stdout: "ok", stderr: "" };
        return typeof a === "string"
          ? { code: 0, stdout: a, stderr: "" }
          : { code: a.code, stdout: "", stderr: a.stderr };
      },
    });
    return { d, calls };
  }

  it("walks the tree through one osascript call with a JSON argument", async () => {
    const { d, calls } = scripted({
      "function nodes": JSON.stringify([
        { role: "window", name: "General", value: null, enabled: true, depth: 0 },
        { role: "checkbox", name: "Allow", value: "1", enabled: true, depth: 1 },
      ]),
    });
    const nodes = await d.tree("System Settings", 3);
    expect(nodes).toHaveLength(2);
    expect(calls[0]?.file).toBe("osascript");
    expect(calls[0]?.args.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
    expect(JSON.parse(calls[0]?.args[5] ?? "{}")).toEqual({
      app: "System Settings",
      depth: 3,
      max: 400,
    });
    expect(treeText(nodes)).toBe('- window "General"\n  - checkbox "Allow": 1');
  });

  it("clicks by role and name, types, presses, and names the missing permission", async () => {
    const { d, calls } = scripted();
    await d.click({ role: "button", name: "Allow", app: "Finder" });
    await d.type("hello");
    await d.key("cmd+q");
    const args = calls.map((c) => JSON.parse(c.args[5] ?? "{}"));
    expect(args[0]).toMatchObject({ role: "button", name: "Allow", app: "Finder" });
    expect(args[1]).toEqual({ text: "hello" });
    expect(args[2]).toEqual({ key: "q", code: null, using: ["command down"] });

    const denied = scripted({
      "function nodes": {
        code: 1,
        stderr: "execution error: Error: osascript is not allowed assistive access. (-1719)",
      },
    });
    await expect(denied.d.tree()).rejects.toThrow(/grant Accessibility/);
  });

  it("opens an app by name and falls back to LaunchServices when it is not scriptable", async () => {
    const { d, calls } = scripted({
      "activate()": { code: 1, stderr: "Application can't be found." },
    });
    await d.open("Some Tool");
    expect(calls.at(-1)).toEqual({ file: "open", args: ["-a", "Some Tool"] });
  });

  it("runs root commands only through the audited helper", async () => {
    const { d, calls } = scripted();
    await d.shell("ls /", false);
    await d.shell("launchctl list", true);
    expect(calls[0]).toEqual({ file: "/bin/sh", args: ["-c", "ls /"] });
    expect(calls[1]).toEqual({ file: "sudo", args: ["-n", ROOT_HELPER, "launchctl list"] });
    expect(sudoersLine("william")).toBe(`william ALL=(root) NOPASSWD: ${ROOT_HELPER}`);
    expect(rootHelper()).toContain('exec /bin/sh -c "$1"');
    expect(rootHelper()).toContain("/var/log/autobrowse-root.log");
    expect(rootSetupCommands("william", "/tmp/h").join("\n")).toContain(
      "/etc/sudoers.d/autobrowse",
    );
  });

  it("a host without a desktop says so", async () => {
    await expect(noDesktop().click({ name: "x" })).rejects.toThrow(/no desktop/);
    expect(await noDesktop().permissions()).toEqual({ accessibility: false, root: false });
  });
});

/** Turning a setting on: open the pane, click, type a password (redacted), then a root command. */
const recording: Recording = {
  name: "allow-remote-login",
  site: "scratch",
  startedAt: "2026-09-21T10:00:00Z",
  finishedAt: "2026-09-21T10:01:00Z",
  trace: null,
  terminal: null,
  commands: [],
  actions: [
    { t: 0, kind: "note", url: "about:blank", text: "Remote login" },
    {
      t: 1,
      kind: "desktop",
      url: "about:blank",
      op: { op: "open", app: "System Settings" },
      redacted: false,
    },
    {
      t: 2,
      kind: "desktop",
      url: "about:blank",
      op: { op: "click", role: "checkbox", name: "Remote Login", app: "System Settings" },
      redacted: false,
    },
    {
      t: 3,
      kind: "desktop",
      url: "about:blank",
      op: { op: "type", text: "<redacted>" },
      redacted: true,
    },
    {
      t: 4,
      kind: "desktop",
      url: "about:blank",
      op: { op: "key", combo: "return" },
      redacted: false,
    },
    {
      t: 5,
      kind: "desktop",
      url: "about:blank",
      op: { op: "shell", command: "systemsetup -getremotelogin", root: true },
      redacted: false,
    },
  ],
};

describe("desktop step", () => {
  it("structures a run of desktop acts into one step with typed text as a secret", () => {
    const o = structure(recording);
    expect(o.steps).toHaveLength(1);
    const step = o.steps[0];
    if (step?.kind !== "desktop") throw new Error("expected a desktop step");
    expect(step.name).toBe("remote-login");
    expect(step.irreversible).toBe(true); // a root command
    expect(step.ops.map((op) => op.kind)).toEqual(["open", "click", "type", "key", "shell"]);
    expect(o.secrets).toEqual([{ key: "typedText1", label: "typed text 1" }]);
    expect(describeOp({ op: "type", text: "x" }, true)).toBe("type (redacted)");
  });

  it("renders deps.desktop calls, the secret outside the journal, and gates the step", () => {
    const { files } = render(structure(recording));
    const src = files["index.ts"] ?? "";
    expect(src).toContain("desktop: Desktop;");
    expect(src).toContain('deps.desktop.open("System Settings")');
    expect(src).toContain(
      'deps.desktop.click({ app: "System Settings", role: "checkbox", name: "Remote Login" })',
    );
    expect(src).toContain('const typedText1 = await deps.secrets.get("typedText1");');
    expect(src).toContain("deps.desktop.type(typedText1)");
    expect(src).toContain("deps.desktop.shell(cmd, root)");
    expect(src).toContain('await sh(4, "systemsetup -getremotelogin", true);');
    expect(src).toContain('gate("human"');
  });

  it("the rendered module typechecks and runs against the fake desktop", async () => {
    const dir = await mkdtemp(join(import.meta.dirname, ".generated-desktop-"));
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
      const fake = fakeDesktop([
        { role: "checkbox", name: "Remote Login", value: "0", enabled: true, depth: 0 },
      ]);
      await fake.click({ role: "checkbox", name: "Remote Login" });
      await expect(fake.click({ name: "Nope" })).rejects.toThrow(/no control named/);
      expect(fake.acts).toEqual([{ op: "click", role: "checkbox", name: "Remote Login" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
