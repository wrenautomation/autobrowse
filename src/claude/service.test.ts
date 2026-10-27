import { describe, expect, it } from "vitest";
import { argsOf, SECRET_READS } from "./service.js";

const ask = (o: object) => ({
  question: "q",
  system: "",
  dir: ".",
  also: [],
  commands: [],
  model: "sonnet",
  ...o,
});

describe("claude/ask", () => {
  it("reads only, never a secret, and runs only the commands named", () => {
    const bare = argsOf(ask({}), "/w", "id-1");
    expect(bare).toContain("--restricted");
    expect(bare[bare.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(bare).not.toContain("--allowedTools");
    for (const s of SECRET_READS) expect(bare).toContain(s);
    expect(bare[bare.indexOf("--session-id") + 1]).toBe("id-1");
    expect(bare[bare.indexOf("--name") + 1]).toBe("ask: q");

    const sql = argsOf(ask({ commands: ["Bash(node q.mjs *)"], also: ["b"] }), "/w", "id-2");
    expect(sql[sql.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Bash");
    expect(sql[sql.indexOf("--allowedTools") + 1]).toBe("Bash(node q.mjs *)");
    expect(sql[sql.indexOf("--add-dir") + 1]).toBe("/w/b");
  });

  it("refuses a folder outside the workspace", () => {
    expect(() => argsOf(ask({ also: ["../etc"] }), "/w", "")).toThrow(/outside/);
    expect(() => argsOf(ask({ also: ["/etc"] }), "/w", "")).toThrow(/outside/);
  });
});
