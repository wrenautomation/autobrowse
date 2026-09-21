import { describe, expect, it } from "vitest";
import { childEnv, claudeCodeLlm } from "../src/llm/claude-code.js";
import { makeLlm } from "../src/llm/index.js";

describe("claudeCodeLlm", () => {
  it("the child never sees ANTHROPIC_API_KEY: the login pays", () => {
    expect(childEnv({ ANTHROPIC_API_KEY: "sk-dead", HOME: "/h" })).toEqual({ HOME: "/h" });
  });

  it("runs claude -p headless with tools off and reads the result", async () => {
    const calls: Array<{ args: string[]; stdin: string }> = [];
    const llm = claudeCodeLlm({
      model: "sonnet",
      run: async (args, stdin) => {
        calls.push({ args, stdin });
        return JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: '{"ok":true}',
          usage: { input_tokens: 120, output_tokens: 8 },
        });
      },
    });
    const reply = await llm.complete({ system: "be terse", prompt: "hi", json: true });
    expect(reply).toEqual({
      text: '{"ok":true}',
      usage: { inputTokens: 120, outputTokens: 8 },
      model: "sonnet",
    });
    const [c] = calls;
    expect(c?.stdin).toBe("hi");
    expect(c?.args.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    expect(c?.args).toContain("--no-session-persistence");
    expect(c?.args[c.args.indexOf("--tools") + 1]).toBe("");
    expect(c?.args[c.args.indexOf("--system-prompt") + 1]).toMatch(
      /be terse[\s\S]*one JSON object/,
    );
    expect(llm.id).toBe("claude-code:sonnet");
  });
  it("surfaces an error result and non-JSON output", async () => {
    const bad = claudeCodeLlm({
      model: "sonnet",
      run: async () =>
        JSON.stringify({ is_error: true, subtype: "error_max_turns", result: "nope" }),
    });
    await expect(bad.complete({ system: "", prompt: "x" })).rejects.toThrow(/error_max_turns/);
    const junk = claudeCodeLlm({ model: "sonnet", run: async () => "Please log in" });
    await expect(junk.complete({ system: "", prompt: "x" })).rejects.toThrow(/not JSON/);
  });
  it("needs no key through makeLlm", () => {
    const llm = makeLlm(
      {
        provider: "claude-code",
        model: undefined,
        anthropicApiKey: undefined,
        openaiApiKey: undefined,
        openaiBaseUrl: undefined,
      },
      {} as never,
    );
    expect(llm?.id).toBe("claude-code:sonnet");
  });
});
