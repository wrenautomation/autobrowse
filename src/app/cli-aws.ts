/**
 * CLI logins renewed by a browser session: `autobrowse aws-login` (the
 * `aws` profile) and `autobrowse wrangler-login` (Cloudflare's session).
 */
import type { Command } from "commander";
import { awsCliLoginChore } from "../chores/aws-login.js";
import { wranglerLoginChore } from "../chores/wrangler-login.js";
import type { LocalBackend } from "./backend.js";
import type { Settings } from "./config.js";
import { browserFor, captchaFor, gmailFor, loginFor } from "./services.js";

export function registerAwsCommands(
  program: Command,
  local: LocalBackend,
  settings: Settings,
): void {
  program
    .command("aws-login")
    .description(
      "Run `aws login --remote` and answer its verification code from the aws browser profile",
    )
    .option("--profile <name>", "AWS CLI profile")
    .option("--user <iam user>", "which console session card to continue (default: the first)")
    .option("--overwrite", "replace the profile's session when it belongs to another identity")
    .action(async (o: { profile?: string; user?: string; overwrite?: boolean }) => {
      const { parts } = local();
      const r = await awsCliLoginChore(parts.browser, {
        ...(o.profile ? { profile: o.profile } : {}),
        ...(o.user ? { user: o.user } : {}),
        ...(o.overwrite ? { overwrite: true } : {}),
      });
      console.log(`${r.ok ? "signed in" : "not signed in"}\n${r.detail}`);
      if (!r.ok) process.exitCode = 1;
    });

  program
    .command("wrangler-login")
    .description(
      "Run `wrangler login` and authorize it from the signed-in Cloudflare session (the browser must run on this machine)",
    )
    .option(
      "--scopes <scopes...>",
      "OAuth scopes (`wrangler login --scopes-list`); wrangler's default set otherwise",
    )
    .option("--cwd <dir>", "run wrangler in this project (its pinned version)")
    .action(async (o: { scopes?: string[]; cwd?: string }) => {
      const { flowRunner } = await import("../browser/flow.js");
      // Cloudflare's own profile: via Google, that is the Google session's.
      const runner = flowRunner(await browserFor(settings, "cloudflare"), {
        login: loginFor(settings, gmailFor(settings)),
        captcha: captchaFor(settings),
      });
      const r = await wranglerLoginChore(runner, {
        ...(o.scopes ? { scopes: o.scopes } : {}),
        ...(o.cwd ? { cwd: o.cwd } : {}),
      });
      console.log(`${r.ok ? "signed in" : "not signed in"}\n${r.detail}`);
      if (!r.ok) process.exitCode = 1;
    });
}
