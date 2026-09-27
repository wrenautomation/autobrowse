import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyFixes, healFailure, healLine, locateFailure } from "../src/agent/heal.js";
import type { SessionView } from "../src/agent/sessions.js";
import { memoryFixes } from "../src/browser/fixes.js";
import type { FailureRecord } from "../src/browser/session.js";
import type { Outline } from "../src/compiler/outline.js";
import { brokenOp, replaceOp, swapHints } from "../src/compiler/patch.js";
import { render } from "../src/compiler/render.js";

const click = (name: string) => ({
  kind: "click" as const,
  goal: `click ${name}`,
  hints: { role: "button", name },
  irreversible: false,
});

const outline: Outline = {
  name: "set-thing",
  site: "acme",
  description: "sets a thing",
  fields: [],
  secrets: [],
  steps: [
    {
      kind: "browser",
      name: "open-settings",
      description: "",
      irreversible: false,
      proof: null,
      url: "https://acme.test/settings",
      ops: [click("Settings")],
    },
    {
      kind: "browser",
      name: "save-thing",
      description: "",
      irreversible: false,
      proof: null,
      url: null,
      ops: [click("Name"), click("Old Save"), click("Done")],
    },
  ],
};

const record: FailureRecord = {
  site: "acme",
  flow: "save-thing",
  url: "https://acme.test/settings",
  goal: "click Old Save",
  hints: { role: "button", name: "Old Save" },
  actsBefore: 1,
  error: "no element matched",
  kind: "failed",
  at: "2026-09-21T00:00:00Z",
};

function compiledDir(): string {
  const root = mkdtempSync(join(tmpdir(), "heal-"));
  const dir = join(root, "set-thing");
  mkdirSync(dir);
  writeFileSync(join(dir, "outline.json"), JSON.stringify(outline));
  // What the model's finish added: a heal must keep it.
  const module = (render(outline, { lib: "../../index.js" }).files["index.ts"] as string).replace(
    "// TODO: prove",
    "// FINISHED: proof read\n    // TODO: prove",
  );
  writeFileSync(join(dir, "index.ts"), module);
  mkdirSync(join(root, "hand-written"));
  return root;
}

function recordingsDir(actions: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), "heal-rec-"));
  const dir = join(root, "set-thing-heal-save-thing");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      name: "set-thing-heal-save-thing",
      site: "acme",
      startedAt: "2026-09-21T00:00:00Z",
      actions,
      commands: [],
    }),
  );
  return root;
}

describe("heal", () => {
  it("locates the compiled workflow, the step and the one op that broke", async () => {
    const root = compiledDir();
    const found = await locateFailure(root, record);
    expect(found).toMatchObject({ name: "set-thing", stepIndex: 1, opIndex: 1 });
    expect(await locateFailure(root, { ...record, flow: "elsewhere" })).toBeNull();
  });

  const agentFor = (goals: string[]) =>
    ({
      start: async (req: { goal: string }) => {
        goals.push(req.goal);
        return { id: "s1" };
      },
      get: () => ({ id: "s1", status: "done", achieved: true, summary: "saved" }) as SessionView,
      save: async (_id: string, name: string) => {
        expect(name).toBe("set-thing-heal-save-thing");
        return {} as SessionView;
      },
      close: async () => undefined,
    }) as never;
  const saveChanges = () =>
    recordingsDir([
      { t: 0, kind: "navigate", url: "https://acme.test/settings" },
      { t: 1, kind: "click", target: { tag: "button", role: "button", name: "Save changes" } },
    ]);

  it("asks the agent for the one act, patches that one statement, no model", async () => {
    const root = compiledDir();
    const goals: string[] = [];
    let checked = 0;
    const out = await healFailure(record, {
      agent: agentFor(goals),
      compiledDir: root,
      recordingsDir: saveChanges(),
      lib: "../../index.js",
      check: async () => {
        checked += 1;
        return null;
      },
      finish: async () => {
        throw new Error("a one-op heal needs no model");
      },
      prove: async () => "proven 2026-09-21T00:00",
      sleep: async () => undefined,
    });
    expect(goals).toEqual([expect.stringMatching(/^Do only this one act .*"click Old Save"/)]);
    expect(out.status).toBe("healed");
    expect(out.summary).toMatch(
      /op 2 of "save-thing" \("click Old Save"\) replaced by 1 op; patched in place, no model; proven/,
    );
    expect(checked).toBe(1);
    const dir = join(root, "set-thing");
    const rewritten = JSON.parse(readFileSync(join(dir, "outline.json"), "utf8")) as Outline;
    const ops = rewritten.steps[1]?.kind === "browser" ? rewritten.steps[1].ops : [];
    expect(ops.map((o) => (o.kind === "human" ? "" : o.hints.name))).toEqual([
      "Name",
      "Save changes",
      "Done",
    ]);
    const src = readFileSync(join(dir, "index.ts"), "utf8");
    expect(src).toContain("// FINISHED: proof read");
    expect(src).toContain('name: "Save changes"');
    expect(src).not.toContain('name: "Old Save"');
    expect(src).toContain('name: "Done"');
    expect(healLine(out)).toMatch(/healed `set-thing`/);
  });

  it("re-renders and has the model finish only when the patch fails the check", async () => {
    const root = compiledDir();
    const finished: string[] = [];
    const out = await healFailure(record, {
      agent: agentFor([]),
      compiledDir: root,
      recordingsDir: saveChanges(),
      lib: "../../index.js",
      check: async () => "index.ts(3,1): error",
      finish: async (name, step) => {
        finished.push(`${name}/${step}`);
        return {
          status: "finished",
          rounds: 1,
          usage: { inputTokens: 1, outputTokens: 1 },
          summary: "ok",
        };
      },
      sleep: async () => undefined,
    });
    expect(finished).toEqual(["set-thing/save-thing"]);
    expect(out.summary).toMatch(/re-rendered, finished by the model; not yet proven/);
    expect(existsSync(join(root, "set-thing", "index.ts"))).toBe(true);
  });

  it("rewrites nothing when the record can't say which act broke", async () => {
    const root = compiledDir();
    const { hints: _h, ...bare } = record;
    const out = await healFailure(bare, {
      agent: agentFor([]),
      compiledDir: root,
      recordingsDir: root,
      lib: "x",
      sleep: async () => undefined,
    });
    expect(out).toMatchObject({ status: "failed", session: null });
    expect(out.summary).toMatch(/can't tell which act/);
  });

  it("--apply writes kept fixes (a detour included) into the workflow, one statement, no model", async () => {
    const root = compiledDir();
    const fixes = memoryFixes();
    fixes.learn({
      site: "acme@wren",
      flow: "acme@wren/save-thing",
      goal: "click Old Save",
      failed: { role: "button", name: "Old Save" },
      hints: { role: "button", name: "Save" },
      detours: [{ role: "button", name: "Not now" }],
      reason: "new dialog",
      url: "https://acme.test/settings",
      ok: true,
    });
    const got = await applyFixes(root, fixes, "../../index.js");
    expect(got).toEqual({ applied: ["set-thing: click Old Save"], rendered: [] });
    expect(fixes.list()).toEqual([]);
    const dir = join(root, "set-thing");
    const saved = JSON.parse(readFileSync(join(dir, "outline.json"), "utf8")) as Outline;
    const ops = saved.steps[1]?.kind === "browser" ? saved.steps[1].ops : [];
    expect(ops.map((o) => (o.kind === "human" ? "" : o.hints.name))).toEqual([
      "Name",
      "Not now",
      "Save",
      "Done",
    ]);
    expect(readFileSync(join(dir, "index.ts"), "utf8")).toContain("// FINISHED: proof read");
  });

  it("leaves a step the agent could not finish, and says so", async () => {
    const root = compiledDir();
    const agent = {
      start: async () => ({ id: "s2" }),
      get: () => ({ id: "s2", status: "needs-human", prompt: "solve the captcha" }) as SessionView,
      close: async () => undefined,
    } as never;
    const out = await healFailure(record, {
      agent,
      compiledDir: root,
      recordingsDir: root,
      lib: "x",
      sleep: async () => undefined,
    });
    expect(out.status).toBe("needs-human");
    expect(healLine(out)).toMatch(
      /could not heal `set-thing` alone: the agent needs you: solve the captcha/,
    );
  });
});

describe("patch", () => {
  const twice: Outline = {
    ...outline,
    steps: [
      {
        kind: "browser",
        name: "login",
        description: "",
        irreversible: false,
        proof: null,
        url: "https://acme.test/login",
        ops: [click("Next"), click("Next"), click("Log in")],
      },
    ],
  };
  const step = twice.steps[0] as Extract<Outline["steps"][number], { kind: "browser" }>;
  const src = render(twice, { lib: "x" }).files["index.ts"] as string;

  it("tells two identical acts apart by how many ran before", () => {
    const next = { role: "button", name: "Next" };
    expect(brokenOp(step, next, "click Next")).toBeNull();
    expect(brokenOp(step, next, "click Next", 1)).toBe(1);
    expect(brokenOp(step, { role: "button", name: "Log in" }, null)).toBe(2);
  });

  it("swaps only the second Next, in outline and source", () => {
    const out = swapHints(twice, src, 0, 1, { role: "link", name: "Continue" });
    expect(out.source).not.toBeNull();
    const acts = (out.source as string).split("\n").filter((l) => l.includes("fp.act("));
    expect(acts.map((l) => /name: "(\w[\w ]*)" }, \{ goal/.exec(l)?.[1])).toEqual([
      "Next",
      "Continue",
      "Log in",
    ]);
    // Nothing else moved.
    expect((out.source as string).split("\n").length).toBe(src.split("\n").length);
  });

  it("gives up on the source (re-render) when the repair types a new plan value", () => {
    const out = replaceOp(twice, src, 0, 2, {
      ops: [
        {
          kind: "fill",
          goal: "fill Code",
          hints: { role: "textbox", name: "Code" },
          value: { from: "plan", field: "code" },
        },
      ],
      fields: [{ key: "code", label: "Code", example: null }],
      secrets: [],
    });
    expect(out.source).toBeNull();
    expect(out.outline.fields.map((f) => f.key)).toEqual(["code"]);
  });
});
