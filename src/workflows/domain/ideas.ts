/**
 * Sending-domain ideas: spellings of the brand across a few extensions, so
 * cold mail never risks the main domain. The fleet's own pattern
 * (wren-automation.com, wrenautomation.net, wrenautomations.com): joined,
 * hyphenated, plural, and a short suffix. No try/meet/get prefixes: they
 * read as funnels. `digits` adds one letter swapped for a look-alike digit
 * (wrenautomati0n): cheap, but a filter may read it as a spoof.
 */
/** .us is left out: it needs a US presence (nexus). */
export const DEFAULT_TLDS = ["com", "net", "org", "co", "io"] as const;
const SUFFIXES = ["hq", "team"];
const DIGITS: Record<string, string> = { o: "0", i: "1", l: "1", e: "3", a: "4", s: "5" };

export function domainIdeas(
  words: string[],
  tlds: readonly string[] = DEFAULT_TLDS,
  opts: { digits?: boolean } = {},
): string[] {
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
  if (opts.digits) for (const d of digitSwaps(w.join(""))) stems.add(d);
  return [...stems]
    .filter((s) => s.length <= 63)
    .flatMap((s) => tlds.map((t) => `${s}.${t.replace(/^\./, "")}`));
}

/** The word with one letter swapped for its look-alike digit, each place in turn. */
export function digitSwaps(word: string): string[] {
  return [...word].flatMap((c, i) => {
    const d = DIGITS[c];
    return d ? [`${word.slice(0, i)}${d}${word.slice(i + 1)}`] : [];
  });
}
