/**
 * `autobrowse creds …`, `autobrowse login <site>`, `autobrowse enroll-totp
 * <site>`: the credential ladder from the terminal. Values arrive on
 * stdin, never as arguments (argv is visible to every process).
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { credentialSchema, readSecretFromPage, SITE_LOGINS, storeSeed } from "../auth/index.js";
import { defineFlow, type FlowPage, flowRunner } from "../browser/flow.js";
import type { Settings } from "./config.js";
import { browserOptions, credentialsFor, gmailFor, loginFor } from "./services.js";

const SITES = SITE_LOGINS.map((s) => s.site);

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
        await runSetup(terminalPrompter(rl, process.stdout), credentialsFor(settings), SITE_LOGINS);
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
      `Sign in to a site with the stored credential (headless). With --headed and no credential, a person logs in and closes the window. Sites: ${SITES.join(", ")}`,
    )
    .option("--headed", "show the browser")
    .action(async (site: string, o: { headed?: boolean }) => {
      const login = SITE_LOGINS.find((s) => s.site === site);
      if (!login) throw new Error(`unknown site ${site}; one of ${SITES.join(", ")}`);
      const opts = browserOptions(settings, !o.headed);
      const cred = await credentialsFor(settings).get(site);
      if (!cred && !o.headed)
        throw new Error(
          `no credential for ${site}: \`autobrowse creds set ${site}\`, or --headed to log in by hand`,
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
    .command("enroll-totp <site>")
    .description(
      "On the site's authenticator setup page, read the seed, store it, and confirm with a generated code",
    )
    .requiredOption("--url <url>", "the two-factor setup page")
    .option("--headed", "show the browser")
    .action(async (site: string, o: { url: string; headed?: boolean }) => {
      const store = credentialsFor(settings);
      const runner = flowRunner(browserOptions(settings, !o.headed), {
        login: loginFor(settings, gmailFor(settings)),
      });
      const enroll = defineFlow<undefined, string>({
        site,
        name: "enroll-totp",
        async run(fp) {
          await fp.open(o.url);
          // Many sites hide the seed behind a "set up" button; press the obvious one once.
          let secret = await readSecretFromPage(fp);
          if (!secret) {
            const started = await fp
              .act(
                { kind: "click" },
                { role: "button", name: "/set up|add|enable|turn on/i" },
                { goal: "start authenticator setup" },
              )
              .then(
                () => true,
                () => false,
              );
            if (started) {
              await fp.wait(1_500);
              secret = await readSecretFromPage(fp);
            }
          }
          if (!secret) return fp.human("no TOTP seed visible on the page");
          const code = await storeSeed(store, site, secret);
          await fp.act(
            { kind: "fill", value: code },
            { role: "textbox" },
            { goal: "type the first code" },
          );
          await fp.act(
            { kind: "click" },
            { role: "button", name: "/verify|confirm|continue|enable|activate/i" },
            { goal: "confirm authenticator" },
          );
          await fp.wait(1_500);
          return `seed stored for ${site}; page now says: ${(await fp.text()).slice(0, 200).replace(/\s+/g, " ")}`;
        },
      });
      console.log(await runner.run(enroll, undefined));
    });
}
