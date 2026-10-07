/**
 * Command-line tools as abilities: "deploy this on cloudflare workers" is
 * `wrangler deploy` in a directory. A tool names its binary, its inputs and
 * the command line they make (every value shell-quoted here); it is ready
 * when the binary is on the PATH. Output is the exit code and the last of
 * what it printed, never logged by the shell itself.
 */
import type { Shell, ShellResult } from "../deps/shell.js";
import type { Ability, Field } from "./catalog.js";

export interface Tool {
  /** `wrangler-deploy`: the ability's name. */
  name: string;
  summary: string;
  /** The binary that must be on the PATH. */
  bin: string;
  /** How to get it, said when it is missing. */
  install: string;
  inputs: readonly (Field & { required?: boolean })[];
  /** The command line; values arrive already shell-quoted. */
  command(q: Record<string, string>): string;
  /** The input field whose value is the working directory, when one is. */
  cwd?: string;
  irreversible?: boolean;
  timeoutMs?: number;
}

/** POSIX single-quoting: safe for any value. */
export const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export const TOOLS: readonly Tool[] = [
  {
    name: "wrangler-deploy",
    summary: "Deploy a Cloudflare Worker from its project directory (wrangler.toml/jsonc there)",
    bin: "wrangler",
    install: "npm i -g wrangler; wrangler login",
    inputs: [{ name: "dir", required: true }, { name: "name" }, { name: "env" }],
    cwd: "dir",
    command: (q) =>
      ["wrangler deploy", q.name ? `--name ${q.name}` : "", q.env ? `--env ${q.env}` : ""]
        .filter(Boolean)
        .join(" "),
    irreversible: true,
    timeoutMs: 300_000,
  },
  {
    name: "wrangler-pages-deploy",
    summary: "Deploy a static directory to a Cloudflare Pages project",
    bin: "wrangler",
    install: "npm i -g wrangler; wrangler login",
    inputs: [
      { name: "dir", required: true },
      { name: "project", required: true },
      { name: "branch" },
    ],
    command: (q) =>
      `wrangler pages deploy ${q.dir} --project-name ${q.project} --branch ${q.branch ?? "'main'"}`,
    irreversible: true,
    timeoutMs: 300_000,
  },
  {
    name: "gh-pr-create",
    summary: "Open a GitHub pull request from the current branch of a repository directory",
    bin: "gh",
    install: "brew install gh; gh auth login",
    inputs: [
      { name: "dir", required: true },
      { name: "title", required: true },
      { name: "body" },
      { name: "base" },
    ],
    cwd: "dir",
    command: (q) =>
      ["gh pr create --title", q.title, "--body", q.body ?? "''", q.base ? `--base ${q.base}` : ""]
        .filter(Boolean)
        .join(" "),
    irreversible: true,
  },
  {
    name: "ffmpeg-convert",
    summary: "Convert a media file to another container or codec (the output's extension decides)",
    bin: "ffmpeg",
    install: "brew install ffmpeg",
    inputs: [
      { name: "input", required: true },
      { name: "output", required: true },
    ],
    command: (q) => `ffmpeg -y -loglevel error -i ${q.input} ${q.output}`,
    timeoutMs: 600_000,
  },
];

/** Tools as abilities: ready when the binary is on the PATH. */
export function toolAbilities(
  tools: readonly Tool[],
  present: (bin: string) => boolean,
): Ability[] {
  return tools.map((t) => {
    const ready = present(t.bin);
    return {
      kind: "tool",
      name: t.name,
      site: null,
      summary: t.summary,
      inputs: t.inputs.map(({ required: _r, ...f }) => f),
      irreversible: Boolean(t.irreversible),
      ready,
      missing: ready ? null : `${t.bin} is not on the PATH (${t.install})`,
    };
  });
}

/** Whether a binary is on the PATH, asked of the shell once per name. */
export function binPresence(shell: Shell): (bin: string) => Promise<boolean> {
  const seen = new Map<string, Promise<boolean>>();
  return (bin) => {
    let p = seen.get(bin);
    if (!p) {
      p = shell.run(`command -v ${shellQuote(bin)}`).then((r) => r.code === 0);
      seen.set(bin, p);
    }
    return p;
  };
}

export class ToolInputError extends Error {}

/** Run one tool with its input; a missing required field is the caller's error. */
export async function runTool(
  tool: Tool,
  input: Record<string, unknown>,
  shell: Shell,
): Promise<{ command: string; result: ShellResult }> {
  const q: Record<string, string> = {};
  for (const f of tool.inputs) {
    const v = input[f.name];
    if (v === undefined || v === null || v === "") {
      if (f.required) throw new ToolInputError(`${tool.name} needs ${f.name}`);
      continue;
    }
    q[f.name] = shellQuote(String(v));
  }
  const command = tool.command(q);
  const cwd = tool.cwd ? String(input[tool.cwd]) : undefined;
  const result = await shell.run(command, {
    ...(cwd ? { cwd } : {}),
    ...(tool.timeoutMs ? { timeoutMs: tool.timeoutMs } : {}),
  });
  return { command, result };
}

/** The tail of a tool's output as `do` answers it: what a person would read at the bottom of the terminal. */
export const tailOf = (s: string, lines = 20) => s.trim().split("\n").slice(-lines).join("\n");
