/**
 * Sending-domain ideas: spellings of the brand across a few extensions, so
 * cold mail never risks the main domain. The fleet's own pattern
 * (wren-automation.com, wrenautomation.net, wrenautomations.com): joined,
 * hyphenated, plural, and a short suffix. No try/meet/get prefixes: they
 * read as funnels.
 */
/** .us is left out: it needs a US presence (nexus). */
export const DEFAULT_TLDS = ["com", "net", "org", "co", "io"] as const;
const SUFFIXES = ["hq", "team"];

export function domainIdeas(words: string[], tlds: readonly string[] = DEFAULT_TLDS): string[] {
  const w = words.flatMap((x) => x.toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean);
  const last = w.at(-1);
  if (!last) return [];
  const head = w.slice(0, -1);
  const plural = [...head, last.endsWith("s") ? last : `${last}s`];
  const stems = new Set([w.join(""), plural.join("")]);
  if (w.length > 1) {
    stems.add(w.join("-"));
    stems.add(plural.join("-"));
  }
  for (const s of SUFFIXES) stems.add(`${w.join("")}${s}`);
  return [...stems]
    .filter((s) => s.length <= 63)
    .flatMap((s) => tlds.map((t) => `${s}.${t.replace(/^\./, "")}`));
}
