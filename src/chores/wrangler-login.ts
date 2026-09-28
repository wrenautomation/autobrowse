/**
 * `autobrowse wrangler-login`: renew wrangler's Cloudflare OAuth token
 * without hands, like `aws-login` for the AWS CLI. `wrangler login
 * --browser=false` prints an authorize URL and waits on localhost:8976; the
 * Cloudflare browser session authorizes it and the CLI keeps its token.
 * The browser must reach the CLI's localhost: run both on one machine.
 */
import { spawn } from "node:child_process";
import type { FlowRunner } from "../browser/flow.js";
import { wranglerLogin } from "../browser/flows/wrangler-login.js";

export interface WranglerLoginOptions {
  /** OAuth scopes (`wrangler login --scopes-list`); wrangler's default set when absent. */
  scopes?: string[];
  /** Where to run wrangler (its project's pinned version); this process's cwd when absent. */
  cwd?: string;
  urlMs?: number;
  spawn?: typeof spawn;
}

export interface WranglerLoginResult {
  ok: boolean;
  /** The CLI's last lines, the URL and long tokens masked. */
  detail: string;
}

const URL_RE = /https:\/\/dash\.cloudflare\.com\/oauth2\/auth\?\S+/;

export async function wranglerLoginChore(
  browser: FlowRunner,
  o: WranglerLoginOptions = {},
): Promise<WranglerLoginResult> {
  const args = [
    "-y",
    "wrangler",
    "login",
    "--browser=false",
    ...(o.scopes?.length ? ["--scopes", ...o.scopes] : []),
  ];
  // An API token in the env would make wrangler skip OAuth: this is the OAuth login.
  const { CLOUDFLARE_API_TOKEN: _t, CF_API_TOKEN: _c, ...env } = process.env;
  const child = (o.spawn ?? spawn)("npx", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    ...(o.cwd ? { cwd: o.cwd } : {}),
  });
  let out = "";
  const done = new Promise<number | null>((resolve) => child.on("exit", resolve));
  child.stdout?.on("data", (d: Buffer) => {
    out += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    out += d.toString();
  });
  try {
    const url = await urlOf(() => out, done, o.urlMs ?? 60_000);
    await browser.run(wranglerLogin, { url });
    const exit = await Promise.race([
      done,
      new Promise<"late">((r) => setTimeout(() => r("late"), 30_000)),
    ]);
    if (exit === "late") throw new Error("wrangler never took the callback");
    return { ok: exit === 0 && /successfully logged in/i.test(out), detail: tail(out) };
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
      throw new Error(`wrangler printed no login URL: ${tail(out())}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The last lines of the CLI's output, the URL and long tokens masked. */
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
