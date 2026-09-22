/**
 * `autobrowse aws-login`: renew the Mac's AWS CLI session without hands.
 * `aws login --remote` prints an authorize URL and waits on stdin for a
 * verification code; the `aws` browser profile (signed in as the IAM user)
 * fetches that code and it is piped straight back. Nothing prints it, no
 * file holds it. The CLI's own cache then refreshes credentials until the
 * console session expires (~12 h), when this runs again.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { FlowRunner } from "../browser/flow.js";
import { awsCliLogin } from "../browser/flows/aws-cli-login.js";

export interface AwsLoginOptions {
  profile?: string;
  /** The IAM user whose console session to continue; the first offered when absent. */
  user?: string;
  /** Answer yes when the profile already holds another identity's session (else the CLI is told no and keeps it). */
  overwrite?: boolean;
  /** How long to wait for the CLI to print its URL. */
  urlMs?: number;
  spawn?: typeof spawn;
}

export interface AwsLoginResult {
  ok: boolean;
  /** The CLI's last lines, secrets masked. */
  detail: string;
}

const URL_RE = /https:\/\/\S+signin\.aws\.amazon\.com\/\S+/;

export async function awsCliLoginChore(
  browser: FlowRunner,
  o: AwsLoginOptions = {},
): Promise<AwsLoginResult> {
  const args = ["login", "--remote", ...(o.profile ? ["--profile", o.profile] : [])];
  const child = (o.spawn ?? spawn)("aws", args, { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  const done = new Promise<number | null>((resolve) => child.on("exit", resolve));
  child.stdout?.on("data", (d: Buffer) => {
    out += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    out += d.toString();
  });
  try {
    // A profile without a region is asked for one first; the default answer is fine.
    if (
      await waitFor(child, () => /AWS Region \[/.test(out) || URL_RE.test(out), o.urlMs ?? 20_000)
    )
      if (!URL_RE.test(out)) child.stdin?.write("\n");
    const url = await waitForUrl(child, () => out, o.urlMs ?? 20_000);
    const { code } = await browser.run(awsCliLogin, { url, ...(o.user ? { user: o.user } : {}) });
    child.stdin?.write(`${code}\n`);
    // "Profile X is already configured to use session <arn>. Overwrite? (y/n)": only on request.
    const asked = await waitFor(child, () => /\(y\/n\)/.test(out), 15_000);
    if (asked) child.stdin?.write(o.overwrite ? "y\n" : "n\n");
    child.stdin?.end();
    const exit = await done;
    return { ok: exit === 0, detail: tail(out) };
  } catch (e) {
    child.kill();
    return { ok: false, detail: `${tail(out)}\n${e instanceof Error ? e.message : String(e)}` };
  }
}

/** True when `test` passes before the CLI exits or `ms` runs out. */
function waitFor(child: ChildProcess, test: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const at = Date.now();
    const tick = setInterval(() => {
      if (test()) {
        clearInterval(tick);
        resolve(true);
      } else if (child.exitCode !== null || Date.now() - at > ms) {
        clearInterval(tick);
        resolve(false);
      }
    }, 100);
  });
}

function waitForUrl(child: ChildProcess, out: () => string, ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const at = Date.now();
    const tick = setInterval(() => {
      const m = URL_RE.exec(out());
      if (m) {
        clearInterval(tick);
        resolve(m[0]);
      } else if (child.exitCode !== null || Date.now() - at > ms) {
        clearInterval(tick);
        reject(new Error(`aws login printed no URL: ${tail(out())}`));
      }
    }, 100);
  });
}

/** The last lines of the CLI's output, long tokens masked. */
function tail(s: string): string {
  return s
    .replace(URL_RE, "<url>")
    .replace(/[A-Za-z0-9_.-]{30,}/g, "<tok>")
    .trim()
    .split("\n")
    .slice(-3)
    .join("\n");
}
