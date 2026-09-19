/**
 * The terminal leg of a chore, replayed. A command's output is returned
 * whole (bounded) and never logged by the shell itself, since `gh auth
 * token` and friends print secrets. Interactive logins are not replayable;
 * the compiler marks those for a person.
 */
import { execFile } from "node:child_process";

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Shell {
  run(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<ShellResult>;
}

const OUTPUT_LIMIT = 64 * 1024;

export function localShell(env: NodeJS.ProcessEnv = process.env): Shell {
  return {
    run(command, opts = {}) {
      return new Promise((resolve) => {
        execFile(
          "/bin/sh",
          ["-c", command],
          {
            env,
            maxBuffer: OUTPUT_LIMIT,
            timeout: opts.timeoutMs ?? 120_000,
            ...(opts.cwd ? { cwd: opts.cwd } : {}),
          },
          (err, stdout, stderr) => {
            const code =
              err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0;
            resolve({ code, stdout: String(stdout), stderr: String(stderr) });
          },
        );
      });
    },
  };
}

/** Scripted shell for tests: a handler per command prefix, and a log of what ran. */
export function fakeShell(handlers: Record<string, ShellResult | string> = {}) {
  const ran: string[] = [];
  const shell: Shell & { ran: string[] } = {
    ran,
    async run(command) {
      ran.push(command);
      const key = Object.keys(handlers).find((k) => command.startsWith(k));
      const h = key ? handlers[key] : undefined;
      if (h === undefined) return { code: 0, stdout: "", stderr: "" };
      return typeof h === "string" ? { code: 0, stdout: h, stderr: "" } : h;
    },
  };
  return shell;
}

/** Commands that ask for input or open a browser cannot run unattended. */
export const INTERACTIVE_COMMANDS =
  /^(gh auth login|aws (sso )?login|aws configure|gcloud auth|restate cloud login|npm login|docker login|ssh-keygen|passwd)\b/;
