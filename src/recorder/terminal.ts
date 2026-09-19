/**
 * Records a shell session with the OS `script` tool (no native modules):
 * the transcript and, where supported, the keys typed. Afterwards the
 * transcript is redacted and the typed commands are pulled out.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { redactText } from "./redact.js";

export function scriptArgs(platform: NodeJS.Platform, file: string, shell: string): string[] {
  // BSD script (macOS): script [-k] [-q] file [command]; util-linux: script -q -c cmd file
  return platform === "darwin" ? ["-q", file, shell] : ["-q", "-c", shell, file];
}

export async function recordTerminal(opts: {
  file: string;
  shell?: string;
  platform?: NodeJS.Platform;
}): Promise<{ commands: string[] }> {
  const shell = opts.shell ?? process.env.SHELL ?? "/bin/sh";
  await new Promise<void>((resolve, reject) => {
    const p = spawn("script", scriptArgs(opts.platform ?? process.platform, opts.file, shell), {
      stdio: "inherit",
    });
    p.on("error", reject);
    p.on("exit", () => resolve());
  });
  const raw = await readFile(opts.file, "utf8");
  const clean = redactText(stripAnsi(raw));
  await writeFile(opts.file, clean);
  return { commands: extractCommands(clean) };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the point
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\r/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** Lines that follow a prompt (`$ `, `% `, `> `, `❯ `), minus the prompt. */
export function extractCommands(transcript: string): string[] {
  const out: string[] = [];
  for (const line of transcript.split("\n")) {
    const m = /^(?:.*?)(?:\$|%|❯|>)\s+(\S.*)$/.exec(line);
    if (!m) continue;
    const cmd = m[1]?.trim() ?? "";
    if (cmd && cmd !== "exit" && !out.includes(cmd)) out.push(cmd);
  }
  return out;
}
