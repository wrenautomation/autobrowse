/**
 * `claude` as a Restate service on the desk: `claude/ask` is one question to Claude Code on
 * this Mac, read only, on the person's own subscription ($0 a question). The caller names the
 * folder it reads (under `root`, the folder holding this checkout) and the commands it may run;
 * the desk keeps Claude Code restricted whatever the caller says: file reads in those folders,
 * never a secret file, no edits, no other command, no MCP server, no session kept.
 */
import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import { childEnv } from "../llm/claude-code.js";

export const CLAUDE_SERVICE = "claude";

/** Never read, whatever the caller allows (Read rules hold for Grep and Glob too). */
export const SECRET_READS = [
  "Read(**/*.env)",
  "Read(**/.env*)",
  "Read(**/*.env.*)",
  "Read(**/*.pem)",
  "Read(**/*.key)",
  "Read(**/*.tfstate*)",
  "Read(**/.ssh/**)",
  "Read(**/credentials*)",
];

/** Under Restate's 10 minute abort, so a long answer fails plainly instead of being retried. */
const TIMEOUT_MS = 8 * 60_000;

const request = z.object({
  question: z.string().min(1).max(4000),
  /** Added to Claude Code's own system prompt: who asks, how to answer, how to reach data. */
  system: z.string().max(8000).default(""),
  /** The folder it works in, under `root`. */
  dir: z.string().default("."),
  /** More folders it may read, under `root`. */
  also: z.array(z.string()).default([]),
  /** Bash rules it may run, like `Bash(node scripts/prod-sql.mjs *)`. Nothing else runs. */
  commands: z.array(z.string().regex(/^Bash\(.+\)$/)).default([]),
  model: z
    .string()
    .regex(/^[\w.-]+$/)
    .default("sonnet"),
});
export type ClaudeAsk = z.input<typeof request>;
export interface ClaudeAnswer {
  answer: string;
  ms: number;
  turns: number;
  model: string;
  /** Tool calls the rules refused. */
  denied: number;
}

export type ClaudeRun = (args: string[], stdin: string, cwd: string) => Promise<string>;

const spawnClaude: ClaudeRun = (args, stdin, cwd) =>
  new Promise((ok, fail) => {
    const child = execFile(
      "claude",
      args,
      { cwd, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: childEnv() },
      (err, stdout, stderr) => {
        // A failed answer still prints its JSON (is_error); let the parser say why.
        if (!err || (!err.killed && stdout.trim().startsWith("{"))) return ok(stdout);
        const why = err.killed ? `took over ${TIMEOUT_MS / 60_000} minutes` : `exit ${err.code}`;
        fail(new restate.TerminalError(`claude: ${why}: ${(stderr || stdout).slice(0, 300)}`));
      },
    );
    child.stdin?.end(stdin);
  });

/** `p` under `root`, or a refusal: the caller never reads outside the workspace. */
function under(root: string, p: string): string {
  const abs = resolve(root, p);
  const r = relative(root, abs);
  if (r.startsWith("..") || isAbsolute(r))
    throw new restate.TerminalError(`${p} is outside the workspace`, { errorCode: 400 });
  return abs;
}

export function argsOf(r: z.output<typeof request>, root: string): string[] {
  return [
    "-p",
    "--restricted",
    "--output-format",
    "json",
    "--model",
    r.model,
    "--tools",
    r.commands.length ? "Read,Grep,Glob,Bash" : "Read,Grep,Glob",
    "--permission-mode",
    "dontAsk",
    ...(r.commands.length ? ["--allowedTools", ...r.commands] : []),
    "--disallowedTools",
    ...SECRET_READS,
    ...(r.also.length ? ["--add-dir", ...r.also.map((d) => under(root, d))] : []),
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--no-session-persistence",
    ...(r.system ? ["--append-system-prompt", r.system] : []),
  ];
}

/** What `claude -p --output-format json` prints; only what we read. */
interface Printed {
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  permission_denials?: unknown[];
}

export function claudeService(root: string, name: string = CLAUDE_SERVICE, run = spawnClaude) {
  return restate.service({
    name,
    handlers: {
      ask: async (ctx: restate.Context, raw: unknown): Promise<ClaudeAnswer> => {
        const r = request.safeParse(raw);
        if (!r.success) throw new restate.TerminalError(r.error.message, { errorCode: 400 });
        const cwd = under(root, r.data.dir);
        const args = argsOf(r.data, root);
        return ctx.run(
          "ask",
          async () => {
            const t0 = Date.now();
            const out = JSON.parse(await run(args, r.data.question, cwd)) as Printed;
            if (out.is_error || typeof out.result !== "string")
              throw new restate.TerminalError(
                `claude: ${(out.result ?? "no answer").slice(0, 300)}`,
              );
            return {
              answer: out.result,
              ms: Date.now() - t0,
              turns: out.num_turns ?? 0,
              model: r.data.model,
              denied: out.permission_denials?.length ?? 0,
            };
          },
          { maxRetryAttempts: 2 },
        );
      },
    },
  });
}
