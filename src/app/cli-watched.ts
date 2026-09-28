/**
 * `autobrowse watched [run]`: what a watched flow did, step by step (see
 * `browser/watch`). No run = the newest; a run is its folder or a name
 * fragment ("cloudflare-login"). Each line: step, outcome, time, goal, url,
 * and the shot to open. The trace replays it: `npx playwright show-trace`.
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Command } from "commander";
import { fileFixes } from "../browser/fixes.js";
import { fileScreens } from "../browser/screens.js";
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

/**
 * `autobrowse repairs [flow]`: every locator a flow's source has wrong and
 * what worked instead, the to-do list for fixing the source. Runs already
 * use these (no wait, no model); `--forget` once the source says the same.
 */
export function registerRepairsCommands(program: Command, settings: Settings): void {
  program
    .command("repairs [flow]")
    .description(
      "Locators a flow's source has wrong and what works instead (runs use the fix already); --forget once the source is changed",
    )
    .option("--apply", "write the fixes into the compiled workflows they belong to (no model)")
    .option(
      "--forget [goal]",
      "drop the flow's fixes (or one goal's): its source now says the same",
    )
    .action(async (flow: string | undefined, o: { forget?: string | true; apply?: boolean }) => {
      const fixes = fileFixes(expandHome(settings.fixesFile));
      if (o.apply) {
        const [{ applyFixes }, { COMPILED_DIR, COMPILED_LIB }] = await Promise.all([
          import("../agent/heal.js"),
          import("./services.js"),
        ]);
        const got = await applyFixes(COMPILED_DIR, fixes, COMPILED_LIB);
        for (const a of got.applied) console.log(`applied  ${a}`);
        for (const r of got.rendered)
          console.log(`re-rendered ${r}: its source had changed; run compile --finish on it`);
        const left = fixes.list().length;
        console.log(
          `${got.applied.length} applied${left ? `; ${left} left (hand-written flows: edit, then --forget)` : ""}`,
        );
        return;
      }
      if (o.forget !== undefined) {
        if (!flow) throw new Error("--forget needs a flow: repairs <site/name> --forget");
        const n = fixes.forget(flow, o.forget === true ? undefined : o.forget);
        console.log(`forgot ${n} fix${n === 1 ? "" : "es"} for ${flow}`);
        return;
      }
      const rows = fixes
        .list()
        .filter((f) => !flow || f.flow === flow || f.flow.startsWith(`${flow}/`));
      if (!rows.length) {
        console.log(flow ? `no fixes for ${flow}` : "no fixes: every flow's locators still match");
        return;
      }
      for (const f of rows)
        console.log(
          `${f.flow}  ${f.goal}\n  was ${JSON.stringify(f.failed)}\n  now ${JSON.stringify(f.hints)}  (${f.reason}; found ${f.found.slice(0, 10)}, used ${f.used}×)`,
        );
    });
}

/**
 * `autobrowse screens [site]`: pages a site showed that no flow knew, and
 * what worked on them (kept from a model's one answer; runs use them with
 * no model since). Each row is a screen to write into the source, then
 * `--forget`.
 */
export function registerScreensCommands(program: Command, settings: Settings): void {
  program
    .command("screens [site]")
    .description(
      "Pages learned on each site and what gets past them (runs use them already); --forget once the source knows the screen",
    )
    .option("--forget", "drop the site's learned screens: the source now knows them")
    .action(async (site: string | undefined, o: { forget?: boolean }) => {
      const learned = fileScreens(expandHome(settings.screensFile));
      if (o.forget) {
        if (!site) throw new Error("--forget needs a site: screens <site> --forget");
        const n = learned.forget(site);
        console.log(`forgot ${n} screen${n === 1 ? "" : "s"} for ${site}`);
        return;
      }
      const rows = learned.list().filter((r) => !site || r.site === site.split("@")[0]);
      if (!rows.length) {
        console.log(
          site ? `no learned screens for ${site}` : "no learned screens: every page met was known",
        );
        return;
      }
      for (const r of rows)
        console.log(
          `${r.site}  ${r.url}\n  shows ${r.landmarks.join(" | ")}\n  ${r.screen ? `is "${r.screen}" of ${r.walk}` : `click ${JSON.stringify(r.click)}`}  (${r.reason}; found ${r.found.slice(0, 10)}, used ${r.used}×)`,
        );
    });
}
