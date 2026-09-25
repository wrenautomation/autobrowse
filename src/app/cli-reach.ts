/**
 * `autobrowse read` and `autobrowse search`: the open web for research,
 * lean enough for an agent to call per lead. Keys come from the
 * environment, then the env store; a backend without one is skipped.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import type { EnvStore } from "credvault";
import { csvRows, ensureMapsServer, mapsReady, mapsScrape, stopMapsServer } from "../reach/maps.js";
import { type Env, READ_ORDER, readPage, SEARCH_ORDER, search } from "../reach/web.js";
import { checkSite } from "../sites/index.js";
import type { LocalBackend } from "./backend.js";

/** This machine's environment first, then the env store; a store that cannot be reached is no key. */
export function reachEnv(store: () => EnvStore): Env {
  return async (name) =>
    process.env[name] ||
    ((await store()
      .get(name)
      .catch(() => null)) ??
      undefined);
}

const order = (via: string | undefined) => via?.split(",").map((v) => v.trim());

export function registerReachCommands(
  program: Command,
  store: () => EnvStore,
  local: LocalBackend,
): void {
  const env = reachEnv(store);
  program
    .command("doctor")
    .description("What answers now: search keys, the Maps scraper, and one live call per site")
    .action(async () => {
      const has = async (n: string) => ((await env(n)) ? "ready" : `no ${n}`);
      console.log(
        `read    jina (${(await env("JINA_API_KEY")) ? "keyed" : "free tier"}), then fetch`,
      );
      console.log(
        `search  exa: ${await has("EXA_API_KEY")} · brave: ${await has("BRAVE_API_KEY")} · duckduckgo: ready`,
      );
      console.log(`maps    ${await mapsReady()}`);
      const sites = local().backend.sites;
      if (!sites) return;
      for (const c of await Promise.all((await sites.list()).map((r) => checkSite(sites, r))))
        console.log(`site    ${c.site.padEnd(10)} ${c.ok ? `ok ${c.ms}ms` : c.why}`);
    });
  program
    .command("read <url>")
    .description(`One page as plain text; backends in order: ${READ_ORDER.join(", ")}`)
    .option("--max <chars>", "cut the text here", "20000")
    .option("--via <backends>", "backends to try, in order (comma list)")
    .option("--json", "the page as JSON")
    .action(async (url: string, o: { max: string; via?: string; json?: boolean }) => {
      const via = order(o.via);
      const p = await readPage(
        url,
        { env },
        { max: Number(o.max) || 20_000, ...(via ? { order: via } : {}) },
      );
      if (o.json) return console.log(JSON.stringify(p));
      console.log(`# ${p.title ?? p.url}\n${p.url} (via ${p.via})\n\n${p.text}`);
      if (p.cut) console.log(`\n[${p.cut} more characters: --max]`);
    });
  program
    .command("search <query...>")
    .description(`Web search; backends in order: ${SEARCH_ORDER.join(", ")}`)
    .option("-n <count>", "how many results", "10")
    .option("--via <backends>", "backends to try, in order (comma list)")
    .option("--json", "the results as JSON")
    .action(async (words: string[], o: { n: string; via?: string; json?: boolean }) => {
      const via = order(o.via);
      const r = await search(
        words.join(" "),
        { env },
        { n: Number(o.n) || 10, ...(via ? { order: via } : {}) },
      );
      if (o.json) return console.log(JSON.stringify(r));
      console.log(`via ${r.via}`);
      r.hits.forEach((h, i) => {
        console.log(`${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`);
      });
    });
  program
    .command("maps <searches...>")
    .description(
      "Google Maps listings as a lead CSV (gosom/google-maps-scraper in Docker); one search per argument",
    )
    .option("--depth <n>", "how far down each results list; 1 is about 20 places", "1")
    .option("--no-email", "skip visiting each website for emails (faster)")
    .option("--max-minutes <n>", "the job gives up after this long", "20")
    .option("--out <file>", "where the CSV goes")
    .option("--keep", "leave the scraper running afterwards")
    .action(
      async (
        searches: string[],
        o: { depth: string; email: boolean; maxMinutes: string; out?: string; keep?: boolean },
      ) => {
        const dataDir = join(homedir(), ".autobrowse", "maps");
        mkdirSync(dataDir, { recursive: true });
        const started = await ensureMapsServer(dataDir);
        try {
          const csv = await mapsScrape(
            {
              keywords: searches,
              depth: Number(o.depth) || 1,
              email: o.email,
              maxMinutes: Number(o.maxMinutes) || 20,
            },
            { onStatus: (s) => console.error(`maps: ${s}`) },
          );
          const slug = (searches[0] ?? "maps")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .slice(0, 40);
          const out = resolve(o.out ?? `maps-${slug}-${new Date().toISOString().slice(0, 10)}.csv`);
          writeFileSync(out, csv);
          console.log(`${csvRows(csv)} places → ${out}`);
          console.log(`into wren: wren email import ${out} --format google-maps --niche <niche>`);
        } finally {
          if (started && !o.keep) await stopMapsServer();
        }
      },
    );
}
