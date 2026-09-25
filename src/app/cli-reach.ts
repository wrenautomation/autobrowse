/**
 * `autobrowse read` and `autobrowse search`: the open web for research,
 * lean enough for an agent to call per lead. Keys come from the
 * environment, then the env store; a backend without one is skipped.
 */
import type { Command } from "commander";
import type { EnvStore } from "credvault";
import { type Env, READ_ORDER, readPage, SEARCH_ORDER, search } from "../reach/web.js";

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

export function registerReachCommands(program: Command, store: () => EnvStore): void {
  const env = reachEnv(store);
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
}
