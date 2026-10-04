/**
 * Research and lead lists: `read` and `search` (the open web, lean enough
 * for an agent to call per lead), `maps` (Google Maps listings), `people`
 * (LinkedIn), `doctor` (what answers now). Keys come from the
 * environment, then the env store; a backend without one is skipped.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import type { EnvStore } from "credvault";
import { SITE_LOGINS } from "../auth/sites.js";
import { egressOf } from "../browser/egress.js";
import type { Person, Profile } from "../browser/flows/linkedin-reach.js";
import { ringCount, type SpentKeys } from "../reach/key-ring.js";
import { writeLeads } from "../reach/linkedin-leads.js";
import { csvRows, ensureMapsServer, mapsReady, mapsScrape, stopMapsServer } from "../reach/maps.js";
import { type Env, READ_ORDER, readPage, SEARCH_ORDER, search } from "../reach/web.js";
import { checkSite } from "../sites/index.js";
import { bold, columns, dim, good, warn } from "../style.js";
import type { LocalBackend } from "./backend.js";
import { checkRow } from "./cli-site.js";

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
  spent: SpentKeys,
): void {
  const env = reachEnv(store);
  /** Which profiles leave through which exit (`browser/egress`), or the config error. */
  const egressLine = () => {
    try {
      const lines = egressOf((n) => process.env[n], {
        signsIn: (site) => SITE_LOGINS.some((l) => l.site === site),
      }).describe();
      return lines.length ? lines.join(" · ") : dim("desk (every profile on this machine's line)");
    } catch (err) {
      return warn((err as Error).message);
    }
  };
  program
    .command("doctor")
    .description("What answers now: search keys, the Maps scraper, browser exits, and one live call per site")
    .action(async () => {
      const has = async (n: string) => ((await env(n)) ? good("ready") : dim(`no ${n}`));
      // Live keys of those held: `exa 2/3` has one out of credit until the 1st.
      const exaRing = async () => {
        const { live, held } = await ringCount("EXA", env, spent);
        const text = `${live}/${held}`;
        return !held ? dim("no EXA_API_KEY") : live === held ? good(text) : warn(text);
      };
      const maps = await mapsReady();
      const rows = [
        [bold("read"), `jina (${(await env("JINA_API_KEY")) ? "keyed" : "free tier"}), then fetch`],
        [
          bold("search"),
          `exa ${await exaRing()} · brave ${await has("BRAVE_API_KEY")} · duckduckgo ${good("ready")}`,
        ],
        [bold("maps"), maps.startsWith("ready") ? good(maps) : warn(maps)],
        [bold("egress"), egressLine()],
      ];
      const sites = local().backend.sites;
      if (sites)
        for (const c of await Promise.all((await sites.list()).map((r) => checkSite(sites, r))))
          rows.push([bold("site"), ...checkRow(c)]);
      for (const line of columns(rows)) console.log(line);
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
        { env, spent },
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
  program
    .command("people [keywords...]")
    .description(
      "LinkedIn people as a lead CSV for wren (as Wren's LinkedIn); resumable: a re-run skips who is already in --out",
    )
    .option("--company <handle>", "a company's people instead of a search (keywords narrow them)")
    .option("--pages <n>", "search result pages, 10 people each", "1")
    .option("--network <degrees>", "F, S, O (1st, 2nd, 3rd+), comma list")
    .option("--enrich", "open each profile and its current employer's page: title, website, size")
    .option("--max <n>", "at most this many people", "50")
    .option("--out <file>", "the CSV (appended to when it exists)")
    .action(
      async (
        words: string[],
        o: {
          company?: string;
          pages: string;
          network?: string;
          enrich?: boolean;
          max: string;
          out?: string;
        },
      ) => {
        const sites = local().backend.sites;
        if (!sites) throw new Error("no site apis here");
        const keywords = words.join(" ");
        if (!keywords && !o.company) throw new Error("keywords, or --company <handle>");
        const max = Number(o.max) || 50;
        const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
        const people = async (): Promise<Person[]> => {
          const out = o.company
            ? await sites.call(
                "linkedin",
                "GET",
                `/company/${encodeURIComponent(o.company)}/people?${q({ ...(keywords ? { keywords } : {}), max: String(max) })}`,
                {},
              )
            : await sites.call(
                "linkedin",
                "GET",
                `/search/results/people?${q({ keywords, pages: o.pages, ...(o.network ? { network: o.network } : {}) })}`,
                {},
              );
          return (out as { people: Person[] }).people;
        };
        const slug = (o.company ?? keywords)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .slice(0, 40);
        const file = resolve(o.out ?? `linkedin-${slug}.csv`);
        const { written, skipped } = await writeLeads(
          {
            people,
            ...(o.enrich
              ? {
                  enrich: async (p: Person) =>
                    (await sites.call(
                      "linkedin",
                      "GET",
                      `/in/${encodeURIComponent(p.vanity)}?${q({ company: "true", ...(p.current ? { prefer: p.current } : {}) })}`,
                      {},
                    )) as Profile,
                }
              : {}),
            existing: existsSync(file) ? readFileSync(file, "utf8") : null,
            append: (t) => appendFileSync(file, t),
            // A person's pace between profiles: LinkedIn watches for bursts.
            pause: () => new Promise((r) => setTimeout(r, 4_000 + Math.random() * 6_000)),
            onRow: (r, n) =>
              console.error(
                `${n}. ${r.full_name} · ${r.title} · ${r.company_name || "?"} ${r.website}`,
              ),
            onMiss: (v, why) => console.error(`   ${v}: not enriched (${why.slice(0, 120)})`),
          },
          max,
        );
        console.log(`${written} people → ${file}${skipped ? ` (${skipped} already there)` : ""}`);
        console.log(`into wren: wren email import-people ${file} --format linkedin`);
      },
    );
}
