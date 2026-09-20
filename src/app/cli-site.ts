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
    .action(async (name: string, method: string, path: string, o: { body?: string }) => {
      const sites = local().backend.sites;
      if (!sites) throw new Error("no site apis here");
      const input = o.body ? ((await readJson(o.body)) as Record<string, unknown>) : {};
      const out = await sites.call(name, method.toUpperCase() as Method, path, input);
      console.log(JSON.stringify(out, null, 2));
    });
  site
    .command("setup <site> <step>")
    .description(
      "Make a key or token: a browser flow on the developer console, or an OAuth consent",
    )
    .action(async (name: string, step: string) => {
      const sites = local().backend.sites;
      if (!sites) throw new Error("no site apis here");
      const { made } = await sites.setup(name, step);
      console.log(`kept ${made.join(", ")}`);
    });
}
