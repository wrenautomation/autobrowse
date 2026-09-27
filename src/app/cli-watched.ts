/**
 * `autobrowse watched [run]`: what a watched flow did, step by step (see
 * `browser/watch`). No run = the newest; a run is its folder or a name
 * fragment ("cloudflare-login"). Each line: step, outcome, time, goal, url,
 * and the shot to open. The trace replays it: `npx playwright show-trace`.
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Command } from "commander";
import { readSteps, watchedRuns } from "../browser/watch.js";
import { expandHome } from "../google-auth.js";
import type { Settings } from "./config.js";

export function registerWatchedCommands(program: Command, settings: Settings): void {
  program
    .command("watched [run]")
    .description(
      "What a watched flow did, step by step (WATCH_FLOWS=<site|site/flow|all>); newest run by default",
    )
    .option("--list", "the watched runs, newest first")
    .action((run: string | undefined, o: { list?: boolean }) => {
      const runs = watchedRuns(expandHome(settings.artifactsDir));
      if (o.list) {
        for (const r of runs.slice(0, 30)) console.log(basename(r));
        if (!runs.length) console.log("no watched runs: set WATCH_FLOWS and run the flow");
        return;
      }
      const dir = run
        ? existsSync(join(run, "steps.jsonl"))
          ? run
          : runs.find((r) => basename(r).includes(run))
        : runs[0];
      if (!dir) {
        console.log(
          run
            ? `no watched run matches ${run}`
            : "no watched runs: set WATCH_FLOWS and run the flow",
        );
        process.exitCode = 1;
        return;
      }
      console.log(dir);
      for (const s of readSteps(dir)) {
        const mark = s.outcome === "ok" ? "ok" : s.outcome === "repaired" ? "REPAIRED" : "FAILED";
        console.log(
          `${String(s.n).padStart(3)} ${mark.padEnd(8)} ${`${(s.ms / 1000).toFixed(1)}s`.padStart(6)}  ${s.kind === "act" ? `${s.op} · ${s.goal}` : s.goal}`,
        );
        console.log(`             ${s.url}${s.shot ? `  ${s.shot}` : ""}`);
        if (s.error) console.log(`             ${s.error}`);
      }
      if (existsSync(join(dir, "trace.zip")))
        console.log(`replay: npx playwright show-trace ${join(dir, "trace.zip")}`);
    });
}
