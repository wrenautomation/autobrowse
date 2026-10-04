/**
 * `autobrowse mods`: pack what this owner learned about a site, and search,
 * add, list or remove mods others packed (src/mods, designs/2026-10-04-mods.md).
 * Publishing a packed mod is a person's `npm publish`; nothing here does it.
 */
import { existsSync, readFileSync } from "node:fs";
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
  searchMods,
} from "../mods/install.js";
import { dataLoginSchema } from "../mods/login.js";
import { installedMods } from "../mods/mod.js";
import { packMod, scrubFrom } from "../mods/pack.js";
import { listWalks } from "../walks/spec.js";
import type { Settings } from "./config.js";
import { credentialsFor, loginsDirFor, modsDirFor, walksDirFor } from "./services.js";

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
    .description("Share what autobrowse learned about a site: pack, search, add, list, remove");

  mods
    .command("pack <site>")
    .description(
      "Pack your walks, learned screens and fixes for a site into a mod folder, scrubbed of every stored value, address and query string; publishing it is your npm publish",
    )
    .option("--walk <name...>", "walks to include (default: every walk of your own on the site)")
    .option("--screens", "include the site's learned screens")
    .option("--fixes", "include the site's kept fixes")
    .option("--login", "include your sign-in as data (logins/<site>.json)")
    .option("--name <npm-name>", "the package name (default autobrowse-mod-<site>)")
    .option("--out <dir>", "where to write it (default ./autobrowse-mod-<site>)")
    .action(
      async (
        site: string,
        o: {
          walk?: string[];
          screens?: boolean;
          fixes?: boolean;
          login?: boolean;
          name?: string;
          out?: string;
        },
      ) => {
        const loginFile = join(loginsDirFor(settings), `${site}.json`);
        if (o.login && !existsSync(loginFile))
          throw new Error(`no login of your own at ${loginFile}`);
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
          ...(o.login
            ? { login: dataLoginSchema.parse(JSON.parse(readFileSync(loginFile, "utf8"))) }
            : {}),
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
    .command("search [words...]")
    .description(
      "Mods on npm (keyword autobrowse-mod): what each opens, gates, and whether it ships code",
    )
    .action(async (words: string[] = []) => {
      const found = await searchMods(words.join(" "));
      if (!found.length) console.log("no mods found");
      for (const f of found)
        console.log(
          `${f.name}@${f.version}  ${f.code ? "CODE" : "data"}  sites ${f.sites.join(",") || "?"}  opens ${f.domains.join(",") || "?"}  gates ${f.gates.join(",") || "none"}\n  ${f.description}`,
        );
    });

  mods
    .command("add <source>")
    .description(
      "Add a mod (an npm name, a folder, or a .tgz): checks its hashes and that every file stays inside the domains, gates and credentials it lists, shows them, and asks yes",
    )
    .option("--yes", "add without asking (after the checks)")
    .option(
      "--trust",
      "allow code (a workflow): it runs with your access, so only from an author you trust; it must pass tsc and its tests first",
    )
    .action(async (source: string, o: { yes?: boolean; trust?: boolean }) => {
      const { dir, cleanup } = await fetchMod(source);
      try {
        const trust = o.trust === true;
        const mod = checkMod(dir, { version: autobrowseVersion(), trust });
        for (const l of permissionLines(mod)) console.log(l);
        if (!o.yes && !(await yes("add it?"))) {
          console.log("not added");
          process.exitCode = 1;
          return;
        }
        console.log(`added ${await installMod(dir, mod, modsDirFor(settings), source, { trust })}`);
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
        console.log(
          `from         ${m.source} (${m.at.slice(0, 10)})${m.trusted ? ", trusted" : ""}\n`,
        );
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
