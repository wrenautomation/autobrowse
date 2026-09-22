import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { healFailure, healLine, locateFailure, spliceStep } from "../src/agent/heal.js";
import type { SessionView } from "../src/agent/sessions.js";
import type { FailureRecord } from "../src/browser/session.js";
import type { Outline } from "../src/compiler/outline.js";

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
      ops: [click("Old Save")],
    },
  ],
};

const record: FailureRecord = {
  site: "acme",
  flow: "save-thing",
  url: "https://acme.test/settings",
  goal: "click Old Save",
  error: "no element matched",
  kind: "failed",
  at: "2026-09-21T00:00:00Z",
};

function compiledDir(): string {
  const root = mkdtempSync(join(tmpdir(), "heal-"));
  const dir = join(root, "set-thing");
  mkdirSync(dir);
  writeFileSync(join(dir, "outline.json"), JSON.stringify(outline));
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
  it("locates the compiled workflow that owns the failed step; hand-written flows have none", async () => {
    const root = compiledDir();
    const found = await locateFailure(root, record);
    expect(found?.name).toBe("set-thing");
    expect(found?.stepIndex).toBe(1);
    expect(await locateFailure(root, { ...record, flow: "elsewhere" })).toBeNull();
  });

  it("splices the repair's ops into the one step and keeps its url", () => {
    const healed: Outline = {
      ...outline,
      name: "x",
      steps: [
        {
          kind: "browser",
          name: "a",
          description: "",
          irreversible: false,
          proof: null,
          url: "https://acme.test/settings",
          ops: [click("Save changes")],
        },
      ],
    };
    const out = spliceStep(outline, 1, healed);
    expect(out.steps[1]).toMatchObject({
      name: "save-thing",
      url: null,
      ops: [click("Save changes")],
    });
    expect(out.steps[0]).toEqual(outline.steps[0]);
    expect(() => spliceStep(outline, 1, { ...healed, steps: [] })).toThrow(/did nothing/);
  });

  it("runs the agent from the failure, rewrites the step, renders and proves", async () => {
    const root = compiledDir();
    const recs = recordingsDir([
      { t: 0, kind: "navigate", url: "https://acme.test/settings" },
      { t: 1, kind: "click", target: { tag: "button", role: "button", name: "Save changes" } },
    ]);
    const views: SessionView[] = [];
    const agent = {
      start: async (req: { goal: string }) => {
        expect(req.goal).toMatch(/finish what the flow "save-thing"/);
        return { id: "s1" };
      },
      get: () => ({ id: "s1", status: "done", achieved: true, summary: "saved" }) as SessionView,
      save: async (_id: string, name: string) => {
        expect(name).toBe("set-thing-heal-save-thing");
        return {} as SessionView;
      },
      close: async () => undefined,
      list: () => views,
    } as never;
    const proven: string[] = [];
    const finished: string[] = [];
    const out = await healFailure(record, {
      agent,
      compiledDir: root,
      recordingsDir: recs,
      lib: "../../index.js",
      finish: async (name, step) => {
        // After the re-render, before the proof: what the model finishes is what gets proven.
        expect(proven).toEqual([]);
        finished.push(`${name}/${step}`);
        return {
          status: "finished",
          rounds: 1,
          usage: { inputTokens: 1, outputTokens: 1 },
          summary: "gate added",
        };
      },
      prove: async (name) => {
        proven.push(name);
        return "proven 2026-09-21T00:00";
      },
      sleep: async () => undefined,
    });
    expect(out.status).toBe("healed");
    expect(proven).toEqual(["set-thing"]);
    expect(finished).toEqual(["set-thing/save-thing"]);
    expect(out.summary).toMatch(/finished by the model/);
    const rewritten = JSON.parse(
      readFileSync(join(root, "set-thing", "outline.json"), "utf8"),
    ) as Outline;
    expect(rewritten.steps[1]).toMatchObject({
      ops: [
        expect.objectContaining({
          kind: "click",
          hints: expect.objectContaining({ name: "Save changes" }),
        }),
      ],
    });
    expect(existsSync(join(root, "set-thing", "index.ts"))).toBe(true);
    expect(healLine(out)).toMatch(/healed `set-thing`/);
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
