/**
 * `autobrowse shots push`: ship this machine's new screenshots (with their
 * aria trees, failure JSON and recording journals) to SHOTS_BUCKET now. The
 * worker does the same on a timer and before an idle stop.
 */
import type { Command } from "commander";
import { shipWording } from "../shots/ship.js";
import { scrubWording } from "../shots/trace-scrub.js";
import { sweepWording, traceWording } from "../shots/traces.js";
import type { Settings } from "./config.js";
import { shipperFor, tracesFor } from "./services.js";

export function registerShotsCommands(program: Command, settings: Settings): void {
  const shots = program.command("shots").description("screenshots as signal: kept in a bucket");
  shots
    .command("push")
    .description("Ship what is new since the last push; resumes where a stopped push left off")
    .option("--dry", "count what would ship")
    .action(async (o: { dry?: boolean }) => {
      const ship = shipperFor(settings, o.dry ? { dry: true } : {});
      if (!ship || !settings.shotsBucket) {
        console.log("no SHOTS_BUCKET set: screenshots stay on this machine");
        process.exitCode = 1;
        return;
      }
      const r = await ship();
      for (const line of shipWording(r, settings.shotsBucket)) console.log(line);
      if (r.refused) process.exitCode = 1;
    });

  const traces = program
    .command("traces")
    .description("Playwright traces: kept for good in TRACES_TO, then swept off this disk");
  const keeper = () => {
    const t = tracesFor(settings);
    if (!t) {
      console.log("no TRACES_TO set: traces stay on this machine and are never swept");
      process.exitCode = 1;
    }
    return t;
  };
  traces
    .command("push")
    .description("Copy every trace not yet kept; resumes where a stopped push left off")
    .option("--dry", "count what would be copied")
    .action(async (o: { dry?: boolean }) => {
      const t = keeper();
      if (!t) return;
      const r = await t.backup(o.dry ? { dry: true } : {});
      for (const line of traceWording(r, t.where)) console.log(line);
      if (r.refused) process.exitCode = 1;
    });
  traces
    .command("scrub")
    .description(
      "Mask secrets (passwords, codes, cookies) in every trace on this disk, in place; --backup scrubs the kept copies too",
    )
    .option(
      "--backup",
      "also fetch, scrub and put back each trace only in TRACES_TO (billed per GB fetched)",
    )
    .action(async (o: { backup?: boolean }) => {
      const t = keeper();
      if (!t) return;
      const r = await t.scrub({ backup: !!o.backup, log: (l) => console.log(l) });
      for (const line of scrubWording(r)) console.log(line);
      if (r.local.leaks || r.backup.leaks || r.local.failed || r.backup.failed)
        process.exitCode = 1;
    });
  traces
    .command("sweep")
    .description("Remove kept traces older than TRACES_KEEP_DAYS from this disk")
    .option("--dry", "name what would be removed")
    .action(async (o: { dry?: boolean }) => {
      const t = keeper();
      if (!t) return;
      const r = await t.sweep(o.dry ? { dry: true } : {});
      for (const line of sweepWording(r, t.keepDays, !!o.dry)) console.log(line);
    });
}
