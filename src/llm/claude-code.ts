/**
 * Claude Code as the model: `claude -p` in headless mode, one process per
 * call. No API key, the person's own subscription; the same Llm seam as the
 * API drivers, so the explorer, compiler and repairer do not know. Nothing
 * on disk is touched: the call runs with tools off and a scratch cwd.
 * Slower to start (~2s per call) than the API; the right pick when steps
 * are few and the person is already paying for Claude Code.
 */
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { type AnthropicUsage, usageOf } from "./anthropic.js";
import type { Llm, LlmReply, LlmRequest } from "./types.js";

export interface ClaudeCodeOptions {
  model: string;
  /** The `claude` binary; default from PATH. */
  bin?: string;
  cwd?: string;
  timeoutMs?: number;
  /** Test seam: what `claude -p` prints. */
  run?: (
    args: string[],
    stdin: string,
    opts: { cwd: string; timeoutMs: number },
  ) => Promise<string>;
}

/** What `claude -p --output-format json` prints; only what we read. */
interface HeadlessResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  /** Input here is only the uncached part: Claude Code's own prompt is nearly all cache. */
  usage?: AnthropicUsage;
}

/**
 * The subscription pays: an ANTHROPIC_API_KEY in this process (a dead or
 * budgeted key meant for the direct provider) would take precedence over
 * the Claude Code login, so the child does not see it.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { ANTHROPIC_API_KEY: _drop, ...rest } = env;
  return rest;
}

function spawnClaude(bin: string) {
  return (args: string[], stdin: string, o: { cwd: string; timeoutMs: number }) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        bin,
        args,
        { cwd: o.cwd, timeout: o.timeoutMs, maxBuffer: 16 * 1024 * 1024, env: childEnv() },
        (err, stdout, stderr) => {
          if (err)
            reject(
              new Error(`claude -p: ${err.message}${stderr ? `: ${stderr.slice(0, 400)}` : ""}`),
            );
          else resolve(stdout);
        },
      );
      child.stdin?.end(stdin);
    });
}

export function claudeCodeLlm(o: ClaudeCodeOptions): Llm {
  const bin = o.bin ?? "claude";
  const run = o.run ?? spawnClaude(bin);
  const cwd = o.cwd ?? tmpdir();
  const timeoutMs = o.timeoutMs ?? 180_000;
  return {
    id: `claude-code:${o.model}`,
    async complete(req: LlmRequest): Promise<LlmReply> {
      const system = req.json
        ? `${req.system}\n\nReply with one JSON object and nothing else.`
        : req.system;
      const args = [
        "-p",
        "--output-format",
        "json",
        "--model",
        o.model,
        "--system-prompt",
        system,
        "--tools",
        "",
        // Nothing of the operator's own setup leaks in: no MCP servers, skills or settings
        // (the Docs connector's instructions once had the model "refocusing" every step).
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--disable-slash-commands",
        "--setting-sources",
        "",
        "--no-session-persistence",
      ];
      // Pictures ride in a stream-json user message (image blocks, then the text); the
      // answer is the stream's `result` line.
      const seeing = Boolean(req.images?.length);
      const input = seeing
        ? `${JSON.stringify({
            type: "user",
            message: {
              role: "user",
              content: [
                ...(req.images ?? []).map((i) => ({
                  type: "image",
                  source: { type: "base64", media_type: i.mediaType, data: i.data },
                })),
                { type: "text", text: req.prompt },
              ],
            },
          })}\n`
        : req.prompt;
      if (seeing) {
        args[2] = "stream-json";
        args.push("--input-format", "stream-json", "--verbose");
      }
      const out = await run(args, input, { cwd, timeoutMs });
      let parsed: HeadlessResult;
      try {
        parsed = seeing
          ? (out
              .split("\n")
              .filter((l) => l.trim().startsWith("{"))
              .map((l) => JSON.parse(l) as HeadlessResult)
              .find((m) => m.type === "result") ?? {})
          : (JSON.parse(out) as HeadlessResult);
      } catch {
        throw new Error(`claude -p: not JSON: ${out.slice(0, 200)}`);
      }
      if (parsed.is_error || typeof parsed.result !== "string") {
        throw new Error(
          `claude -p: ${parsed.subtype ?? "error"}: ${(parsed.result ?? "").slice(0, 300)}`,
        );
      }
      return {
        text: parsed.result,
        usage: usageOf(parsed.usage),
        model: o.model,
      };
    },
  };
}
