import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { finish, parseReply } from "../src/compiler/finish.js";
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
      "=== index.ts ===\nexport const v = 2;\n=== index.test.ts ===\n// test v2\n=== NOTES ===\nsplit\n",
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
      "=== index.ts ===\nbad 1\n=== NOTES ===\n",
      "=== index.ts ===\nbad 2\n=== NOTES ===\n",
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
      llm: fakeLlm(["UNCHANGED\n=== NOTES ===\nalready gated\n"]),
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
    const llm = fakeLlm(["=== index.ts ===\ntry 1\n=== NOTES ===\n"]);
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
      "=== index.ts ===\ndeps.browser\n=== NOTES ===\n",
      "=== index.ts ===\ndeps.sink.put(x)\ndeps.browser\n=== NOTES ===\nkept\n",
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

describe("parseReply", () => {
  it("takes whole files between markers, fences and all", () => {
    const r = parseReply(
      "=== index.ts ===\n```ts\nconst a = `x` + 1;\n```\n=== index.test.ts ===\nit();\n=== NOTES ===\ndid it\nand more\n",
    );
    expect(r).toMatchObject({
      unchanged: false,
      module: "const a = `x` + 1;\n",
      test: "it();\n",
      notes: "did it",
    });
  });

  it("reads UNCHANGED, and gives null for a missing section", () => {
    expect(parseReply("UNCHANGED\n=== NOTES ===\nnothing to do\n")).toMatchObject({
      unchanged: true,
      notes: "nothing to do",
    });
    expect(parseReply("=== index.ts ===\nx\n").test).toBeNull();
  });
});

describe("clean", () => {
  it("drops what a compiler will not take", async () => {
    const { clean } = await import("../src/compiler/finish.js");
    expect(clean("const​ a = “x”;")).toBe('const a = "x";');
  });
});
