/**
 * `autobrowse site`: the site APIs from the terminal, on the same Backend
 * the HTTP face serves. `site` lists them, `site <name>` says what answers
 * and what setup is left, `site <name> call` is one official call, `site
 * <name> setup <step>` makes a key or token.
 */
import type { Command } from "commander";
import type { Method } from "../sites/index.js";
import type { LocalBackend } from "./backend.js";
import { readJson } from "./cli-json.js";

export function registerSiteCommands(program: Command, local: LocalBackend): void {
  const site = program
    .command("site")
    .description("Services under their official API's shape: API with a token, browser without")
    .action(async () => {
      const sites = local().backend.sites;
      if (!sites) throw new Error("no site apis here");
      for (const s of await sites.list()) {
        const left = s.setup.filter((x) => !x.done).map((x) => x.name);
        console.log(
          `${s.site.padEnd(10)} ${s.authed ? "token ok" : "no token"}  routes: ${s.routes.length}  setup left: ${left.join(", ") || "none"}`,
        );
      }
    });
  site
    .command("status <site>")
    .description("Every route and how it answers now; every setup step and what blocks it")
    .action(async (name: string) => {
      const sites = local().backend.sites;
      if (!sites) throw new Error("no site apis here");
      const s = await sites.status(name);
      console.log(`${s.site} → ${s.origin}  ${s.authed ? "token ok" : "no token"}`);
      for (const r of s.routes)
        console.log(
          `  ${r.method.padEnd(6)} ${r.path.padEnd(40)} ${r.via.padEnd(7)} ${r.irreversible ? "!" : " "} ${r.missing ?? r.summary}`,
        );
      for (const st of s.setup)
        console.log(
          `  setup ${st.name.padEnd(14)} ${st.done ? "done" : st.blockedOn.length ? `blocked on ${st.blockedOn.join(", ")}` : st.unrecorded ? `flow ${st.unrecorded} not recorded` : "ready"}  → ${st.makes.join(", ")}`,
        );
    });
  site
    .command("call <site> <method> <path>")
    .description(
      "One call as the official API takes it; `--body` is inline JSON, a file, or - for stdin",
    )
    .option("--body <json|file>", "the request body (writes) or query (reads)")
    .option(
      "--account <address>",
      "as that consented account (its own token); the site's own by default",
    )
    .action(
      async (
        name: string,
        method: string,
        path: string,
        o: { body?: string; account?: string },
      ) => {
        const sites = local().backend.sites;
        if (!sites) throw new Error("no site apis here");
        const input = o.body ? ((await readJson(o.body)) as Record<string, unknown>) : {};
        const out = await sites.call(
          name,
          method.toUpperCase() as Method,
          path,
          input,
          o.account ?? null,
        );
        console.log(JSON.stringify(out, null, 2));
      },
    );
  site
    .command("setup <site> <step>")
    .description(
      "Make a key or token: a browser flow on the developer console, or an OAuth consent",
    )
    .option(
      "--account <address>",
      "consent as that account (a `<site>@<label>` credential with that username signs in); its token is kept under its own name",
    )
    .option(
      "--profile <name>",
      "force the browser profile it runs in: a second profile for the same account, when the first one's session is stuck",
    )
    .action(async (name: string, step: string, o: { account?: string; profile?: string }) => {
      const sites = local().backend.sites;
      if (!sites) throw new Error("no site apis here");
      const { made } = await sites.setup(name, step, o.account ?? null, o.profile ?? null);
      console.log(`kept ${made.join(", ")}`);
    });
  site
    .command("renew")
    .description(
      "Make again every kept token that lapses within 14 days, by the setup step and account that made it (the box runs this daily)",
    )
    .option("--dry", "only say what is due")
    .action(async (o: { dry?: boolean }) => {
      const sites = local().backend.sites;
      if (!sites?.renew) throw new Error("no site apis here");
      const r = await sites.renew({ dry: Boolean(o.dry) });
      console.log(r.lines.join("\n") || "nothing lapses within 14 days");
      if (r.results.some((x) => !x.ok)) process.exitCode = 1;
    });
}
