/**
 * `autobrowse creds …`, `autobrowse login <site>`, `autobrowse enroll-totp
 * <site>`: the credential ladder from the terminal. Values arrive on
 * stdin, never as arguments (argv is visible to every process).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import {
  credentialSchema,
  enrollPasskeyFlow,
  enrollTotpFlow,
  ingest,
  parseCredentialLines,
  resolveLogin,
  rotatePasswordFlow,
  SITE_LOGINS,
  takeClipboard,
  takeFile,
} from "../auth/index.js";
import { defineFlow, type FlowPage, flowRunner } from "../browser/flow.js";
import type { Settings } from "./config.js";
import { browserOptions, credentialsFor, devicesFor, gmailFor, loginFor } from "./services.js";

const SITES = SITE_LOGINS.map((s) => s.site);
const KNOWN = `one of ${SITES.join(", ")}, or <site>@<account> for a second account`;

/** A site name (or `site@account`) as a login, or a clear error. */
function loginNamed(site: string) {
  const login = resolveLogin(SITE_LOGINS, site);
  if (!login) throw new Error(`unknown site ${site}; ${KNOWN}`);
  return login;
}

export function registerAuthCommands(program: Command, settings: Settings): void {
  program
    .command("setup")
    .description(
      "Ask once for what is missing (root credentials), store it sealed; the rest is automated",
    )
    .action(async () => {
      const { createInterface } = await import("node:readline/promises");
      const { runSetup, terminalPrompter } = await import("./setup.js");
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      try {
        await runSetup(
          terminalPrompter(rl, process.stdout),
          credentialsFor(settings),
          SITE_LOGINS,
          {
            devices: devicesFor(settings),
          },
        );
      } finally {
        rl.close();
      }
    });

  const creds = program.command("creds").description("Site credentials for automated sign-in");
  creds
    .command("set <site>")
    .description(
      'Store a credential from stdin JSON: {"username","password","totpSecret"?,"codesInbox"?}',
    )
    .action(async (site: string) => {
      const raw = JSON.parse(readFileSync(0, "utf8"));
      const parsed = credentialSchema.safeParse(raw);
      if (!parsed.success) {
        for (const i of parsed.error.issues) console.error(`${i.path.join(".")}: ${i.message}`);
        process.exitCode = 1;
        return;
      }
      await credentialsFor(settings).put(site, parsed.data);
      console.log(`stored credential for ${site}`);
    });
  creds
    .command("rotate <site>")
    .description(
      "Change the site's password to a new random one, stored sealed; nothing is printed",
    )
    .option("--headed", "show the browser")
    .action(async (site: string, o: { headed?: boolean }) => {
      const login = loginNamed(site);
      const runner = flowRunner(
        browserOptions(settings, o.headed ? false : settings.browserHeadless),
        {
          login: loginFor(settings, gmailFor(settings)),
        },
      );
      console.log(await runner.run(rotatePasswordFlow(login, credentialsFor(settings)), undefined));
    });
  creds
    .command("paste <site>")
    .description(
      "Store what is on the clipboard: `email password [authenticator key]`; the clipboard is emptied after",
    )
    .action(async (site: string) => {
      const lines = parseCredentialLines(takeClipboard(), site);
      if (lines.length !== 1) throw new Error("the clipboard must hold exactly one line");
      console.log(`stored: ${(await ingest(credentialsFor(settings), lines)).join(", ")}`);
    });
  creds
    .command("import <file>")
    .description(
      "Store every line of a scratch file (`site email password [authenticator key]`), then shred the file",
    )
    .action(async (file: string) => {
      const lines = parseCredentialLines(takeFile(file));
      console.log(`stored: ${(await ingest(credentialsFor(settings), lines)).join(", ")}`);
    });
  creds
    .command("list")
    .description("Sites with a stored credential (names only)")
    .action(async () => {
      const store = credentialsFor(settings);
      for (const site of await store.list()) {
        const c = await store.get(site);
        console.log(`${site}\t${c?.totpSecret ? "totp" : "no totp"}`);
      }
    });

  program
    .command("login <site>")
    .description(
      `Sign in to a site with the stored credential (headless). With --headed and no credential, a person logs in and closes the window. Sites: ${KNOWN}`,
    )
    .option("--headed", "show the browser")
    .action(async (site: string, o: { headed?: boolean }) => {
      const login = loginNamed(site);
      const opts = browserOptions(settings, o.headed ? false : settings.browserHeadless);
      const credName = login.credential ?? site;
      const cred = await credentialsFor(settings).get(credName);
      if (!cred && !o.headed)
        throw new Error(
          `no credential for ${site}: \`autobrowse creds set ${credName}\`, or --headed to log in by hand`,
        );
      const runner = flowRunner(opts, { login: loginFor(settings, gmailFor(settings)) });
      const check = defineFlow<undefined, string>({
        site,
        name: "login",
        async run(fp: FlowPage) {
          await fp.open(login.home); // a wall here triggers the sign-in
          if (await login.loggedIn(fp)) return "signed in";
          if (!o.headed) fp.human("not signed in after opening the home page");
          console.log("log in, then close the browser window");
          await new Promise<void>((resolve) => fp.page.context().on("close", () => resolve()));
          return "closed";
        },
      });
      console.log(await runner.run(check, undefined));
    });

  program
    .command("workspace-logo <file>")
    .description("Set the Google Workspace logo (admin console; 320×132 PNG under 30 KB)")
    .option("--headed", "show the browser")
    .action(async (file: string, o: { headed?: boolean }) => {
      const { googleWorkspaceLogo } = await import("../browser/flows/google-workspace-logo.js");
      const runner = flowRunner(
        browserOptions(settings, o.headed ? false : settings.browserHeadless),
        {
          login: loginFor(settings, gmailFor(settings)),
        },
      );
      console.log(await runner.run(googleWorkspaceLogo, { file: resolve(file) }));
    });

  program
    .command("enroll-passkey <site>")
    .description(
      "Create a passkey on the site with our own authenticator and keep it; sign-ins then need no password or code",
    )
    .option("--headed", "show the browser")
    .action(async (site: string, o: { headed?: boolean }) => {
      const login = loginNamed(site);
      const runner = flowRunner(
        browserOptions(settings, o.headed ? false : settings.browserHeadless),
        {
          login: loginFor(settings, gmailFor(settings)),
        },
      );
      console.log(await runner.run(enrollPasskeyFlow(login, credentialsFor(settings)), undefined));
    });

  program
    .command("enroll-totp <site>")
    .description(
      "Turn on an authenticator for the site ourselves: read the seed off its setup page, store it sealed, confirm with a generated code",
    )
    .option("--url <url>", "the two-factor setup page, when the site's walk is not known")
    .option("--headed", "show the browser")
    .action(async (site: string, o: { url?: string; headed?: boolean }) => {
      const login = resolveLogin(SITE_LOGINS, site) ?? { site };
      const runner = flowRunner(
        browserOptions(settings, o.headed ? false : settings.browserHeadless),
        {
          login: loginFor(settings, gmailFor(settings)),
        },
      );
      console.log(
        await runner.run(enrollTotpFlow(login, credentialsFor(settings), o.url), undefined),
      );
    });
}
