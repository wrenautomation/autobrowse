/**
 * `autobrowse shots push`: ship this machine's new screenshots (with their
 * aria trees, failure JSON and recording journals) to SHOTS_BUCKET now. The
 * worker does the same on a timer and before an idle stop.
 */
import type { Command } from "commander";
import { shipWording } from "../shots/ship.js";
import type { Settings } from "./config.js";
import { shipperFor } from "./services.js";

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
}
