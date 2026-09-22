/** `autobrowse aws-login`: renew the AWS CLI session through the signed-in `aws` browser profile. */
import type { Command } from "commander";
import { awsCliLoginChore } from "../chores/aws-login.js";
import type { LocalBackend } from "./backend.js";

export function registerAwsCommands(program: Command, local: LocalBackend): void {
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
}
