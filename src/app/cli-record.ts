/** `autobrowse login <site>` and `autobrowse record <name>`: the recorder's command line. */
import type { Command } from "commander";
import { SITES, type Site } from "../browser/flow.js";
import { openSession } from "../browser/session.js";
import type { Settings } from "./config.js";
import { browserOptions } from "./services.js";

export function registerRecordCommands(program: Command, settings: Settings): void {
  program
    .command("login <site>")
    .description(
      `Open a headed browser on the site's persistent profile; log in, close it. Sites: ${Object.keys(SITES).join(", ")}`,
    )
    .action(async (site: string) => {
      if (!(site in SITES))
        throw new Error(`unknown site ${site}; one of ${Object.keys(SITES).join(", ")}`);
      const opts = browserOptions(settings, false);
      if (opts.tier !== "local") throw new Error("login needs BROWSER=local");
      const session = await openSession(site, opts);
      await session.page.goto(SITES[site as Site].home);
      console.log("log in, then close the browser window");
      await new Promise<void>((resolve) => session.context.on("close", () => resolve()));
    });

  program
    .command("record <name>")
    .description(
      "Record a chore: a headed browser with an observer, play/pause from this terminal, optional terminal capture",
    )
    .option("--site <site>", "use this site's logged-in profile", "scratch")
    .option("--url <url>", "start here")
    .option("--terminal", "also record a shell session in this terminal after the browser closes")
    .action(async (name: string, o: { site: string; url?: string; terminal?: boolean }) => {
      const { recordChore } = await import("../recorder/index.js");
      const opts = browserOptions(settings, false);
      if (opts.tier !== "local") throw new Error("record needs BROWSER=local");
      const dir = await recordChore({
        name,
        site: o.site,
        startUrl: o.url ?? null,
        terminal: o.terminal ?? false,
        recordingsDir: settings.recordingsDir,
        browser: opts,
        io: { stdin: process.stdin, stdout: process.stdout },
      });
      console.log(`recording saved to ${dir}`);
    });
}
