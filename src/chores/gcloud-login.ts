/**
 * `autobrowse gcloud-login`: renew the Mac's gcloud CLI credentials without
 * hands, like `aws-login`. `gcloud auth login --no-launch-browser` prints a
 * Google authorize URL and waits on stdin for a verification code; the
 * `google` profile consents as the account, the code comes back in the
 * redirect URL, and it is piped straight to the CLI. Nothing prints it.
 * A Workspace session-control reauth expires the grant; this runs again then.
 */
import { spawn } from "node:child_process";
import type { FlowRunner } from "../browser/flow.js";
import { googleOauthConsent } from "../browser/flows/oauth-consent.js";

export interface GcloudLoginOptions {
  /** The Google account gcloud signs in as (picked in the chooser). */
  account: string;
  /** The `google@<label>` credential whose profile holds that account's session; `google` when absent. */
  site?: string;
  urlMs?: number;
  spawn?: typeof spawn;
}

export interface GcloudLoginResult {
  ok: boolean;
  /** The CLI's last lines, the URL and long tokens masked. */
  detail: string;
}

const URL_RE = /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?\S+/;

export async function gcloudLoginChore(
  browser: FlowRunner,
  o: GcloudLoginOptions,
): Promise<GcloudLoginResult> {
  const args = ["auth", "login", o.account, "--no-launch-browser", "--brief"];
  const child = (o.spawn ?? spawn)("gcloud", args, { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  const done = new Promise<number | null>((resolve) => child.on("exit", resolve));
  child.stdout?.on("data", (d: Buffer) => {
    out += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    out += d.toString();
  });
  try {
    const url = await urlOf(() => out, done, o.urlMs ?? 30_000);
    const { landed } = await browser.run(
      { ...googleOauthConsent, site: o.site ?? googleOauthConsent.site },
      { url, account: o.account },
    );
    const code = new URL(landed).searchParams.get("code");
    if (!code) throw new Error("Google's redirect carried no code");
    child.stdin?.end(`${code}\n`);
    const exit = await Promise.race([
      done,
      new Promise<"late">((r) => setTimeout(() => r("late"), 60_000)),
    ]);
    if (exit === "late") throw new Error("gcloud never took the code");
    return { ok: exit === 0, detail: tail(out) };
  } catch (e) {
    child.kill();
    return { ok: false, detail: `${tail(out)}\n${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The authorize URL once printed; an error if the CLI exits or `ms` runs out first. */
async function urlOf(out: () => string, done: Promise<unknown>, ms: number): Promise<string> {
  let exited = false;
  void done.then(() => {
    exited = true;
  });
  const at = Date.now();
  for (;;) {
    const m = URL_RE.exec(out());
    if (m) return m[0];
    if (exited || Date.now() - at > ms)
      throw new Error(`gcloud printed no login URL: ${tail(out())}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The last lines of the CLI's output, the URL, long tokens and addresses masked. */
function tail(s: string): string {
  return s
    .replace(URL_RE, "<url>")
    .replace(/[A-Za-z0-9_.-]{30,}/g, "<tok>")
    .replace(/[A-Za-z0-9._%+-]+@/g, "***@")
    .trim()
    .split("\n")
    .slice(-3)
    .join("\n");
}
