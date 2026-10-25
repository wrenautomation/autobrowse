/**
 * `autobrowse film <tape> --out <dir>`: type a tape in a filmed terminal; each command it runs
 * films its own browser into the same take (designs/2026-10-24-film.md).
 */
import type { Command } from "commander";
import { takePanes } from "../browser/film.js";
import { filmTape } from "../film/director.js";
import { loadTape } from "../film/tape.js";
import { expandHome } from "../google/auth.js";

export function registerFilmCommand(program: Command): void {
  program
    .command("film <tape>")
    .description(
      "Type a tape in a filmed terminal; each browser its commands open films itself into the same take",
    )
    .requiredOption("--out <dir>", "the take folder (must hold no panes yet)")
    .action(async (file: string, o: { out: string }) => {
      const dir = expandHome(o.out);
      if ((await takePanes(dir)).length) {
        console.error(`film: ${dir} holds a take already; pick a new folder`);
        process.exitCode = 1;
        return;
      }
      const take = await filmTape(await loadTape(file), {
        tape: file,
        dir,
        log: (line) => console.error(line),
      });
      console.log(`take ${take.dir}: ${take.panes.join(", ")}`);
    });
}
