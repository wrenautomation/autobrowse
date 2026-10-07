import { describe, expect, it } from "vitest";
import { fakeShell } from "../src/deps/shell.js";
import { memorySink } from "../src/deps/sink.js";
import { doerFor } from "../src/do/index.js";
import { filePicks, memoryPicks } from "../src/do/memory.js";
import { pickAbility } from "../src/do/pick.js";
import { binPresence, runTool, shellQuote, TOOLS, toolAbilities } from "../src/do/tools.js";
import { fakeLlm } from "../src/llm/fake.js";
import { fakeBrowser } from "./fakes.js";

const emptyCatalog = { list: async () => [], get: async () => null, proofs: async () => ({}) };

describe("tools as abilities", () => {
  it("quotes every value, runs in the input's directory, needs the required fields", async () => {
    const shell = fakeShell({
      wrangler: "Deployed wren (1.2 sec)\nhttps://wren.example.workers.dev",
    });
    const deploy = TOOLS.find((t) => t.name === "wrangler-deploy");
    if (!deploy) throw new Error("no wrangler-deploy");
    const out = await runTool(deploy, { dir: "/tmp/it's here", name: "wren" }, shell);
    expect(out.command).toBe("wrangler deploy --name 'wren'");
    expect(shell.ran).toEqual(["wrangler deploy --name 'wren'"]);
    expect(out.result.stdout).toContain("workers.dev");
    await expect(runTool(deploy, {}, shell)).rejects.toThrow(/needs dir/);
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });

  it("deploys a static directory to a Pages project, on main unless a branch is named", async () => {
    const shell = fakeShell({ wrangler: "Deployment complete!" });
    const pages = TOOLS.find((t) => t.name === "wrangler-pages-deploy");
    if (!pages) throw new Error("no wrangler-pages-deploy");
    expect(pages).toMatchObject({ irreversible: true, timeoutMs: 300_000 });
    expect(pages.cwd).toBeUndefined();
    const out = await runTool(pages, { dir: "/tmp/it's site", project: "acme-lp" }, shell);
    expect(out.command).toBe(
      "wrangler pages deploy '/tmp/it'\\''s site' --project-name 'acme-lp' --branch 'main'",
    );
    const preview = await runTool(pages, { dir: "out", project: "p", branch: "draft" }, shell);
    expect(preview.command).toBe("wrangler pages deploy 'out' --project-name 'p' --branch 'draft'");
    await expect(runTool(pages, { project: "p" }, shell)).rejects.toThrow(/needs dir/);
    await expect(runTool(pages, { dir: "out" }, shell)).rejects.toThrow(/needs project/);
  });

  it("is ready when the binary is on the PATH, and says how to get it otherwise", async () => {
    const shell = fakeShell({
      "command -v 'gh'": { code: 0, stdout: "/usr/bin/gh", stderr: "" },
      "command -v": { code: 1, stdout: "", stderr: "" },
    });
    const present = binPresence(shell);
    expect(await present("gh")).toBe(true);
    expect(await present("wrangler")).toBe(false);
    await present("gh");
    expect(shell.ran.filter((r) => r.includes("'gh'"))).toHaveLength(1);
    const rows = toolAbilities(TOOLS, (bin) => bin === "gh");
    expect(rows.find((r) => r.name === "gh-pr-create")).toMatchObject({
      kind: "tool",
      ready: true,
      irreversible: true,
    });
    expect(rows.find((r) => r.name === "wrangler-deploy")?.missing).toMatch(/npm i -g wrangler/);
    expect(rows.find((r) => r.name === "ffmpeg-convert")?.inputs.map((f) => f.name)).toEqual([
      "input",
      "output",
    ]);
  });

  it("the verb runs a tool by name and answers with the exit code and the output's tail", async () => {
    const shell = fakeShell({
      "command -v": { code: 0, stdout: "/x", stderr: "" },
      "ffmpeg -y": { code: 1, stdout: "", stderr: "in.mov: No such file or directory" },
    });
    const verb = doerFor({
      llm: null,
      catalog: emptyCatalog,
      browser: fakeBrowser([]),
      sink: memorySink(),
      flows: {},
      logins: [],
      shell,
    });
    const out = await verb.do({
      goal: "ffmpeg-convert",
      inputs: { input: "in.mov", output: "out.mp4" },
    });
    expect(out).toMatchObject({ via: "tool", name: "ffmpeg-convert", status: "failed" });
    expect(out.output).toMatchObject({
      code: 1,
      command: "ffmpeg -y -loglevel error -i 'in.mov' 'out.mp4'",
    });
    expect(out.summary).toContain("No such file");
    await expect(verb.do({ goal: "ffmpeg-convert", inputs: { input: "a" } })).rejects.toThrow(
      /needs output/,
    );
  });
});

describe("pick memory", () => {
  it("earlier picks reach the model, and a model pick is remembered; an exact name is not", async () => {
    const mem = memoryPicks([{ goal: "ship the worker", ability: "wrangler-deploy", at: "t" }]);
    const llm = fakeLlm([
      JSON.stringify({ ability: "wrangler-deploy", input: { dir: "." }, why: "same as before" }),
    ]);
    const shell = fakeShell({
      "command -v": { code: 0, stdout: "/x", stderr: "" },
      wrangler: "ok",
    });
    const verb = doerFor({
      llm,
      catalog: emptyCatalog,
      browser: fakeBrowser([]),
      sink: memorySink(),
      flows: {},
      logins: [],
      shell,
      memory: mem,
    });
    const out = await verb.do({ goal: "deploy this on cloudflare workers", inputs: { dir: "." } });
    expect(out).toMatchObject({ via: "tool", name: "wrangler-deploy", status: "done" });
    expect(llm.requests[0]?.prompt).toContain(
      'EARLIER PICKS:\n- "ship the worker" → wrangler-deploy',
    );
    expect(mem.pairs.map((p) => p.goal)).toEqual([
      "ship the worker",
      "deploy this on cloudflare workers",
    ]);
    await verb.do({ goal: "wrangler-deploy", inputs: { dir: "." } });
    expect(mem.pairs).toHaveLength(2);
  });

  it("keeps the newest pair per goal, capped, in a file", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const file = join(mkdtempSync(join(tmpdir(), "picks-")), "nested", "picks.json");
    const picks = filePicks(file);
    expect(await picks.recall()).toEqual([]);
    await picks.remember("a", "x");
    await picks.remember("b", "y");
    await picks.remember("a", "z");
    expect((await picks.recall()).map((p) => `${p.goal}:${p.ability}`)).toEqual(["b:y", "a:z"]);
    const pick = await pickAbility(null, { goal: "a", inputs: {} }, [], []);
    expect(pick.ability).toBeNull();
  });
});
