/**
 * `autobrowse do "<goal>"`: the one verb from the terminal. A goal is routed
 * to the site route, workflow or flow that does it and run; with nothing
 * ready, the agent explores and what it achieved is compiled for next time.
 */
import type { Command } from "commander";
import { fieldLine } from "../do/catalog.js";
import type { LocalBackend } from "./backend.js";

export function registerDoCommands(program: Command, local: LocalBackend): void {
  program
    .command("do <goal>")
    .description(
      'One verb: "upload this to youtube", "list my linkedin posts". Routes to what does it, or the agent builds it',
    )
    .option("--input <k=v...>", "named values the goal may use (file=…, title=…)")
    .option("--site <site>", "the site profile to work in (found from the goal when absent)")
    .option("--url <url>", "where the agent starts when it explores")
    .option("--dry-run", "say what would run, run nothing")
    .action(
      async (
        goal: string,
        o: { input?: string[]; site?: string; url?: string; dryRun?: boolean },
      ) => {
        const { backend } = local();
        const out = await backend.do.do({
          goal,
          inputs: Object.fromEntries(
            (o.input ?? []).map((kv) => {
              const i = kv.indexOf("=");
              return i < 0 ? [kv, ""] : [kv.slice(0, i), kv.slice(i + 1)];
            }),
          ),
          site: o.site ?? null,
          url: o.url ?? null,
          dryRun: o.dryRun ?? false,
        });
        console.log(
          `${out.status} via ${out.via}${out.name ? ` ${out.name}` : ""}: ${out.summary}`,
        );
        if (Object.keys(out.input).length) console.log(`input ${JSON.stringify(out.input)}`);
        if (out.output !== null && out.output !== undefined)
          console.log(
            typeof out.output === "string" ? out.output : JSON.stringify(out.output, null, 2),
          );
        if (out.session) console.log(`session ${out.session}`);
        if (out.status === "failed") process.exitCode = 1;
      },
    );
  program
    .command("abilities")
    .description("Everything `do` can pick from right now, and what is not recorded yet")
    .action(async () => {
      for (const a of await local().backend.abilities())
        console.log(
          `${a.kind.padEnd(8)} ${a.name.padEnd(48)} ${a.ready ? "ready" : `not ready: ${a.missing}`}${a.irreversible ? "  !" : ""}${a.inputs.length ? `\n         ${a.inputs.map(fieldLine).join(", ")}` : ""}`,
        );
    });
}
