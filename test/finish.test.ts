import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { finish } from "../src/compiler/finish.js";
import { fakeLlm } from "../src/llm/fake.js";

function dir() {
  const d = mkdtempSync(join(tmpdir(), "finish-"));
  writeFileSync(join(d, "index.ts"), "export const v = 1;\n");
  writeFileSync(join(d, "index.test.ts"), "// test v1\n");
  writeFileSync(join(d, "outline.json"), '{"name":"x"}\n');
  return d;
}
const read = (d: string, f: string) => readFileSync(join(d, f), "utf8");

describe("finish", () => {
  it("writes the model's files once the check passes", async () => {
    const d = dir();
    const llm = fakeLlm([
      { "index.ts": "export const v = 2;\n", "index.test.ts": "// test v2\n", notes: "split" },
    ]);
    const checked: string[] = [];
    const out = await finish({
      llm,
      dir: d,
      check: async (at) => {
        checked.push(read(at, "index.ts"));
        return null;
      },
      exemplar: { module: "// exemplar", test: "// exemplar test" },
      brief: "the send is a post",
    });
    expect(out).toMatchObject({ status: "finished", rounds: 1, summary: "split" });
    expect(checked).toEqual(["export const v = 2;\n"]);
    expect(read(d, "index.test.ts")).toBe("// test v2\n");
    const prompt = llm.requests[0]?.prompt ?? "";
    expect(prompt).toContain("Context: the send is a post");
    expect(prompt).toContain("// exemplar test");
    expect(prompt).toContain('{"name":"x"}');
    expect(prompt).toContain("export const v = 1;");
  });

  it("feeds the errors back and restores the originals when it gives up", async () => {
    const d = dir();
    const llm = fakeLlm([
      { "index.ts": "bad 1\n", notes: "" },
      { "index.ts": "bad 2\n", notes: "" },
    ]);
    const out = await finish({
      llm,
      dir: d,
      rounds: 2,
      check: async (at) => `typecheck:\n${read(at, "index.ts").trim()} is not valid`,
    });
    expect(out.status).toBe("gave-up");
    expect(out.rounds).toBe(2);
    expect(out.summary).toContain("bad 2 is not valid");
    expect(llm.requests[1]?.prompt).toContain("bad 1 is not valid");
    expect(llm.requests[1]?.prompt).toContain("--- index.ts ---\nbad 1");
    expect(read(d, "index.ts")).toBe("export const v = 1;\n");
    expect(read(d, "index.test.ts")).toBe("// test v1\n");
  });

  it("leaves a module the model calls finished alone", async () => {
    const d = dir();
    const out = await finish({
      llm: fakeLlm([{ unchanged: true, notes: "already gated" }]),
      dir: d,
      check: async () => {
        throw new Error("no check when unchanged");
      },
    });
    expect(out).toMatchObject({ status: "unchanged", summary: "already gated" });
    expect(read(d, "index.ts")).toBe("export const v = 1;\n");
  });
});

describe("finish on a failing model", () => {
  it("restores the originals when the model call throws mid-loop", async () => {
    const d = mkdtempSync(join(tmpdir(), "finish-"));
    writeFileSync(join(d, "index.ts"), "orig\n");
    writeFileSync(join(d, "index.test.ts"), "orig test\n");
    const llm = fakeLlm([{ "index.ts": "try 1\n", notes: "" }]);
    await expect(finish({ llm, dir: d, check: async () => "typecheck:\nno" })).rejects.toThrow(
      /no reply scripted/,
    );
    expect(readFileSync(join(d, "index.ts"), "utf8")).toBe("orig\n");
    expect(readFileSync(join(d, "index.test.ts"), "utf8")).toBe("orig test\n");
  });
});

describe("dropped", () => {
  it("names deps and stored values the rewrite lost", async () => {
    const { dropped } = await import("../src/compiler/finish.js");
    const orig = 'await deps.sink.put("GOOGLE_CLOUD_PROJECT", id); deps.browser.run(f, x);';
    expect(dropped(orig, "deps.browser.run(f, x);")).toMatch(
      /deps\.sink, \.put\("GOOGLE_CLOUD_PROJECT"/,
    );
    expect(dropped(orig, orig)).toBeNull();
  });

  it("sends a dropped-behaviour reply back as a failed round", async () => {
    const d = mkdtempSync(join(tmpdir(), "finish-"));
    writeFileSync(join(d, "index.ts"), "deps.sink.put(x)\n");
    writeFileSync(join(d, "index.test.ts"), "t\n");
    const llm = fakeLlm([
      { "index.ts": "deps.browser\n", notes: "" },
      { "index.ts": "deps.sink.put(x)\ndeps.browser\n", notes: "kept" },
    ]);
    const checks: string[] = [];
    const out = await finish({
      llm,
      dir: d,
      check: async (at) => {
        checks.push(readFileSync(join(at, "index.ts"), "utf8"));
        return null;
      },
    });
    expect(out.status).toBe("finished");
    expect(checks).toEqual(["deps.sink.put(x)\ndeps.browser\n"]);
    expect(llm.requests[1]?.prompt).toContain("behaviour dropped");
  });
});
