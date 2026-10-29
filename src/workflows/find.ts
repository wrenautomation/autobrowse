/** Search over names and aims: MiniSearch, in-process, rebuilt per call (a few hundred entries). */
import MiniSearch from "minisearch";

/** What search reads: a name, a site, an aim, and any more words (input and step names). */
export interface Findable {
  name: string;
  site: string | null;
  aim: string;
  words?: string;
}

/**
 * Fuzzy, prefixed search; an exact name ranks first. Short terms match exactly:
 * a prefix "a" would match everything.
 */
export function find<T extends Findable>(items: readonly T[], q: string, limit = 10): T[] {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  const index = new MiniSearch<Findable & { id: number }>({
    fields: ["name", "site", "aim", "words"],
    storeFields: [],
    searchOptions: {
      boost: { name: 3, site: 2 },
      combineWith: "OR",
      prefix: (term) => term.length >= 3,
      fuzzy: (term) => (term.length >= 4 ? 0.2 : false),
    },
  });
  index.addAll(items.map((t, id) => ({ ...t, site: t.site ?? "", id }) as never));
  const hits = index.search(query).map((r) => items[r.id as number] as T);
  const exact = items.find((t) => t.name === query);
  return (exact ? [exact, ...hits.filter((t) => t !== exact)] : hits).slice(0, limit);
}
