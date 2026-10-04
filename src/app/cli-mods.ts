/**
 * `autobrowse mods`: pack what this owner learned about a site, and add,
 * list or remove mods others packed (src/mods, designs/2026-10-04-mods.md).
 * Publishing a packed mod is a person's `npm publish`; nothing here does it.
 */
import { join } from "node:path";
import type { Command } from "commander";
import { fileFixes } from "../browser/fixes.js";
import { fileScreens } from "../browser/screens.js";
import { expandHome } from "../google-auth.js";
import {
  autobrowseVersion,
  checkMod,
  fetchMod,
  installMod,
  permissionLines,
  removeMod,
} from "../mods/install.js";
import { installedMods } from "../mods/mod.js";
import { packMod, scrubFrom } from "../mods/pack.js";
import { listWalks } from "../walks/spec.js";
import type { Settings } from "./config.js";
import { credentialsFor, modsDirFor, walksDirFor } from "./services.js";

async function yes(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

export function registerModsCommands(program: Command, settings: Settings): void {
  const mods = program
    .command("mods")
    .description("Share what autobrowse learned about a site: pack, add, list, remove");

  mods
    .command("pack <site>")
    .description(
      "Pack your walks, learned screens and fixes for a site into a mod folder, scrubbed of every stored value, address and query string; publishing it is your npm publish",
    )
    .option("--walk <name...>", "walks to include (default: every walk of your own on the site)")
    .option("--screens", "include the site's learned screens")
    .option("--fixes", "include the site's kept fixes")
    .option("--name <npm-name>", "the package name (default autobrowse-mod-<site>)")
    .option("--out <dir>", "where to write it (default ./autobrowse-mod-<site>)")
    .action(
      async (
        site: string,
        o: { walk?: string[]; screens?: boolean; fixes?: boolean; name?: string; out?: string },
      ) => {
        const walksDir = walksDirFor(settings);
        const walks =
          o.walk ??
          listWalks(walksDir)
            .filter((w) => w.site === site && !w.mod)
            .map((w) => w.name);
        // Every stored value, canaries too (unarmed, so none trips): masked, and refused if any is left.
        const scrub = await scrubFrom(credentialsFor(settings, { armed: false, shared: false }));
        const p = packMod({
          site,
          walksDir,
          walks,
          ...(o.screens ? { screens: fileScreens(expandHome(settings.screensFile)).list() } : {}),
          ...(o.fixes ? { fixes: fileFixes(expandHome(settings.fixesFile)).list() } : {}),
          scrub,
          out: o.out ?? join(process.cwd(), o.name ?? `autobrowse-mod-${site}`),
          version: autobrowseVersion(),
          ...(o.name ? { name: o.name } : {}),
        });
        console.log(`packed ${p.dir}`);
        for (const l of permissionLines(p.mod)) console.log(`  ${l}`);
        for (const k of p.kept) console.log(`  kept     ${k}`);
        for (const d of p.dropped) console.log(`  dropped  ${d}`);
        console.log(`check it, then publish it yourself: cd ${p.dir} && npm publish`);
      },
    );

  mods
    .command("add <source>")
    .description(
      "Add a mod (an npm name, a folder, or a .tgz): checks its hashes and that every file stays inside the domains, gates and credentials it lists, shows them, and asks yes",
    )
    .option("--yes", "add without asking (after the checks)")
    .action(async (source: string, o: { yes?: boolean }) => {
      const { dir, cleanup } = await fetchMod(source);
      try {
        const mod = checkMod(dir, { version: autobrowseVersion() });
        for (const l of permissionLines(mod)) console.log(l);
        if (!o.yes && !(await yes("add it?"))) {
          console.log("not added");
          process.exitCode = 1;
          return;
        }
        console.log(`added ${installMod(dir, mod, modsDirFor(settings), source)}`);
      } finally {
        cleanup();
      }
    });

  mods
    .command("list")
    .description("Installed mods: what each opens, asks for, and where it came from")
    .action(() => {
      const all = installedMods(modsDirFor(settings));
      if (!all.length) console.log("no mods; see: autobrowse mods add <npm-name|dir>");
      for (const m of all) {
        for (const l of permissionLines(m.mod)) console.log(l);
        console.log(`from         ${m.source} (${m.at.slice(0, 10)})\n`);
      }
    });

  mods
    .command("remove <name>")
    .description("Remove a mod; what it already taught your own screens and fixes stays")
    .action((name: string) => {
      if (removeMod(modsDirFor(settings), name)) console.log(`removed ${name}`);
      else {
        console.log(`no mod ${name}; see: autobrowse mods list`);
        process.exitCode = 1;
      }
    });
}
