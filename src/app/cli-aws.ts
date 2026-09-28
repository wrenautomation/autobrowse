/**
 * CLI logins renewed by a browser session: `autobrowse aws-login` (the
 * `aws` profile) and `autobrowse wrangler-login` (Cloudflare's session);
 * `autobrowse cloudflare-token` mints a scoped API token for unattended deploys.
 */
import type { Command } from "commander";
import { awsCliLoginChore } from "../chores/aws-login.js";
import { wranglerLoginChore } from "../chores/wrangler-login.js";
import type { LocalBackend } from "./backend.js";
import type { Settings } from "./config.js";
import {
  bootstrapDepsFor,
  browserFor,
  captchaFor,
  gmailFor,
  loginFor,
  sinkFor,
} from "./services.js";

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

  program
    .command("cloudflare-token <name>")
    .description(
      "Mint a Cloudflare API token from the signed-in dashboard, verify it, store it under --env. The bootstrap workflow, in this process (the browser runs here)",
    )
    .requiredOption(
      "--perm <scope:permission:level...>",
      'one per row, as the dashboard lists it, e.g. "Account:Workers Scripts:Edit" "Zone:DNS:Edit"',
    )
    .requiredOption("--env <KEY>", "where the token is stored (the env store: .env and SSM)")
    .option("--force", "mint even when the stored token still verifies")
    .action(async (name: string, o: { perm: string[]; env: string; force?: boolean }) => {
      const { flowRunner } = await import("../browser/flow.js");
      const { memoryEffects } = await import("../engine/memory.js");
      const { runFlow } = await import("../engine/run.js");
      const { bootstrapWorkflow } = await import("../workflows/bootstrap/index.js");
      const permissions = o.perm.map((p) => {
        const [scope, permission, level] = p.split(":").map((x) => x.trim());
        if (!scope || !permission || !level)
          throw new Error(`--perm "${p}": want scope:permission:level`);
        return { scope, name: permission, level };
      });
      const runner = flowRunner(await browserFor(settings, "cloudflare"), {
        login: loginFor(settings, gmailFor(settings)),
        captcha: captchaFor(settings),
      });
      const plan = bootstrapWorkflow.plan.parse({
        provider: "cloudflare",
        tokenName: name,
        envKey: o.env,
        permissions,
        force: o.force ?? false,
      });
      const out = await runFlow(
        memoryEffects().fx,
        bootstrapWorkflow,
        bootstrapDepsFor(settings, runner, sinkFor(settings)),
        plan,
        () => ({
          approved: true,
          note: "autobrowse cloudflare-token",
          at: new Date().toISOString(),
        }),
      );
      for (const [step, r] of Object.entries(out.results))
        if (r) console.log(`${step.padEnd(12)} ${r.status}  ${r.detail}`);
      console.log(out.status);
      if (out.status !== "done") process.exitCode = 1;
    });
}
