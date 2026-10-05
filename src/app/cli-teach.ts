/**
 * `autobrowse teach <site> <name>`: do a chore once by hand in a headed
 * browser; it becomes a walk (designs/2026-10-05-teach-mode.md). The build
 * guesses where each value comes from next time, a short review confirms,
 * `--mod <dir>` packs it for someone else.
 */
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { expandHome } from "../google-auth.js";
import { autobrowseVersion } from "../mods/install.js";
import type { Profile } from "../money/profile.js";
import { buildWalk } from "../walks/build.js";
import { walkFlowName } from "../walks/flow.js";
import { loadWalk, saveWalk, walkFile } from "../walks/spec.js";
import { guessLine, packInto, review } from "../walks/teach.js";
import { explorerOpener } from "./backend.js";
import type { Settings } from "./config.js";
import { headed } from "./screen.js";
import { profilesForPlace, runsDirFor, walksDirFor } from "./services.js";

export function registerTeachCommand(program: Command, settings: Settings): void {
  program
    .command("teach <site> <name>")
    .description(
      "Do a chore by hand in a browser; it becomes a walk that replays with no model. Type done here or close the browser when finished",
    )
    .option("--url <url>", "start here")
    .option("--goal <words>", "what the chore does (asked at the end if left out)")
    .option("--profile <id>", "whose details you typed (default: the only profile)")
    .option("--yes", "take every guess, no review")
    .option("--mod <dir>", "also pack the walk into this mod folder")
    .option("--port <port>", "loopback port", "9091")
    .action(
      async (
        site: string,
        name: string,
        o: {
          url?: string;
          goal?: string;
          profile?: string;
          yes?: boolean;
          mod?: string;
          port: string;
        },
      ) => {
        if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`name ${name}: a-z, 0-9, dashes`);
        const { tokenFileFor } = await import("../explore/server.js");
        const tokenFile = tokenFileFor(Number(o.port));
        const ex = await explorerOpener(settings, undefined, headed)(site, Number(o.port), {
          tokenFile,
          idleMinutes: 0,
          driver: "person",
          ...(o.goal ? { goal: o.goal } : {}),
        });
        const run = ex.runId();
        if (o.url) await ex.exec({ cmd: "open", url: o.url });
        console.log(
          `teaching ${site}/${name}: do the chore in the browser, then type done here (or close the browser)`,
        );
        console.log(`loopback http://127.0.0.1:${ex.port}, token file ${tokenFile}`);

        const tty = process.stdin.isTTY === true;
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        // No terminal (a script drives the loopback): it ends with `close` or the browser.
        const typedDone = tty
          ? (async () => {
              for (;;) {
                const line = await rl.question("").catch(() => null);
                if (line === null || line.trim() === "done") return;
              }
            })()
          : new Promise<void>(() => undefined);
        await Promise.race([ex.done, typedDone]);
        await ex.exec({ cmd: "close" }).catch(() => undefined);
        await ex.done;
        if (!run) throw new Error("explore kept no run; nothing to build");

        const goal =
          o.goal ??
          (tty
            ? (await rl.question("what did that do? (one line) ")).trim() || undefined
            : undefined);
        const profile = await profilesForPlace(settings)?.(o.profile ?? null).catch(
          (): Profile | null => null,
        );
        const walksDir = walksDirFor(settings);
        // Teach the same name again: the new run joins the ones before it.
        const before = loadWalk(walksDir, site, name)?.from.map((f) => f.run) ?? [];
        const built = buildWalk(runsDirFor(settings), {
          site,
          name,
          runs: [...before, run],
          ...(goal ? { goal } : {}),
          profile: profile ?? null,
        });
        for (const x of built.skipped) console.log(`  skipped ${x.run}: ${x.reason}`);
        let spec = built.spec;
        let allowed: string[] = [];
        if (o.yes || !tty) for (const g of built.guesses) console.log(`  ${guessLine(spec, g)}`);
        else
          ({ spec, allowed } = await review(spec, built.guesses, {
            say: (l) => console.log(l),
            ask: (p) => rl.question(p),
          }));
        rl.close();
        saveWalk(walksDir, spec);
        console.log(
          `${spec.site}/${walkFlowName(spec)}: ${spec.screens.length} screens from ${built.used.length} run(s)`,
        );
        console.log(`  ${walkFile(walksDir, spec.site, spec.name)}`);
        if (o.mod) {
          const packed = packInto(expandHome(o.mod), spec, {
            allowed,
            version: autobrowseVersion(),
          });
          console.log(`  packed ${packed.file} (${packed.mod.name}@${packed.mod.version})`);
        }
        const plan = spec.fields
          .filter((f) => f.default === undefined)
          .map((f) => ` --plan ${f.key}=…`)
          .join("");
        console.log(
          `run it: autobrowse walks run ${spec.site}/${spec.name}${plan}${spec.irreversible ? " --yes" : ""}`,
        );
      },
    );
}
