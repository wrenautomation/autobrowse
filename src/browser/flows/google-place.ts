/**
 * A business's Google Place ID from its name and address, read off Google Maps signed out
 * (`web GET /place`). wren's Google review link setup asks for it when the setup is done for
 * the client: the Place ID makes the review link.
 *
 * Mapped 2026-10-09, signed out. A search that matches one place lands on its page: the name in
 * the `h1`, the address on `[data-item-id=address]`, and the feature id (`0x…:0x…`) in the URL,
 * but no Place ID anywhere in the DOM. The Place ID comes in the `/search?tbm=map` response the
 * page loads, as `["<feature id>",null,null,"<kg id>","ChIJ…"`, so the flow keeps those responses.
 * A search that matches many lands on a list (`[role=feed]`): each result is a link whose
 * `aria-label` is the name and whose href carries `!19s<Place ID>`. A found name must share more
 * than half its words with the query's name (`nameFits`), so a near miss is no answer.
 */
import { defineFlow, type FlowPage } from "../flow.js";

export const MAPS = "https://www.google.com/maps";
const LAND_MS = 15_000;
const SETTLE_MS = 800;
/** The list's results kept as candidates. */
const MAX_CANDIDATES = 10;

export interface PlaceInput {
  /** The business's name and address in one line: "Northwind Plumbing, 12 Elm St, Springfield". */
  q: string;
}

export interface Candidate {
  name: string;
  placeId: string | null;
}

export interface Place {
  query: string;
  /** Null when no place on the page carries the query's name. */
  placeId: string | null;
  name: string | null;
  address: string | null;
  /** The Maps page it was read on. */
  url: string;
  /** "place": one match; "list": many, the first whose name fits; "none": nothing matched. */
  via: "place" | "list" | "none";
  candidates: Candidate[];
}

/** What the page script reads. */
export interface RawPlace {
  kind: "place" | "list" | "none" | null;
  name: string | null;
  address: string | null;
  links: Array<{ label: string; href: string }>;
}

export const placeSearchUrl = (q: string): string =>
  `${MAPS}/search/?${new URLSearchParams({ api: "1", query: q, hl: "en" })}`;

const PLACE_ID = /ChIJ[\w-]{10,200}/;

/** The Place ID a Maps place link carries (`!19sChIJ…`), or null. */
export function placeIdOfHref(href: string): string | null {
  const m = /!19s(ChIJ[\w-]+)/.exec(decodeURIComponent(href));
  return m ? (m[1] as string) : null;
}

/** The feature id (`0x…:0x…`) in a place page's URL, or null. */
export function featureOf(url: string): string | null {
  const m = /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i.exec(decodeURIComponent(url));
  return m ? (m[1] as string).toLowerCase() : null;
}

/**
 * The Place ID for `feature` in Maps' search responses. With no feature, or none paired, the one
 * Place ID the responses carry, if they carry exactly one.
 */
export function placeIdIn(bodies: readonly string[], feature: string | null): string | null {
  const pairs = new Map<string, string>();
  const all = new Set<string>();
  for (const b of bodies) {
    for (const m of b.matchAll(/"(0x[0-9a-f]+:0x[0-9a-f]+)",null,null,"[^"]*","(ChIJ[\w-]+)"/gi))
      pairs.set((m[1] as string).toLowerCase(), m[2] as string);
    for (const m of b.matchAll(new RegExp(PLACE_ID.source, "g"))) all.add(m[0]);
  }
  if (feature && pairs.has(feature)) return pairs.get(feature) as string;
  return all.size === 1 ? ([...all][0] as string) : null;
}

const FILLER = new Set(["the", "and", "of", "llc", "inc", "co", "ltd", "corp", "company"]);
const words = (s: string): string[] =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !FILLER.has(w));

/**
 * The place the query names: more than half the words of the shorter of the two names are in
 * both. The query's name is its part before the first comma ("Northwind Plumbing, 12 Elm St"),
 * or all of it with no comma. Strictly more than half, so one shared trade word ("Plumbing") is
 * not a match.
 */
export function nameFits(name: string, q: string): boolean {
  const own = new Set(words(name));
  const asked = new Set(words(q.includes(",") ? (q.split(",")[0] as string) : q));
  if (!own.size || !asked.size) return false;
  const both = [...own].filter((w) => asked.has(w)).length;
  return both * 2 > Math.min(own.size, asked.size);
}

/** The answer from what the page showed and what Maps sent. */
export function placeOf(q: string, url: string, raw: RawPlace, bodies: readonly string[]): Place {
  const candidates = raw.links
    .map((l) => ({ name: l.label.trim(), placeId: placeIdOfHref(l.href) }))
    .filter((c) => c.name)
    .slice(0, MAX_CANDIDATES);
  const none: Place = {
    query: q,
    placeId: null,
    name: null,
    address: null,
    url,
    via: "none",
    candidates,
  };
  if (raw.kind === "place" && raw.name) {
    const placeId = nameFits(raw.name, q) ? placeIdIn(bodies, featureOf(url)) : null;
    return { ...none, placeId, name: raw.name, address: raw.address, via: "place" };
  }
  if (raw.kind === "list") {
    const hit = candidates.find((c) => c.placeId && nameFits(c.name, q));
    if (hit) return { ...none, placeId: hit.placeId, name: hit.name, via: "list" };
  }
  return none;
}

/** A place's page, a list of places, Maps saying it found nothing, or null while it loads. */
export const PLACE_SCRIPT = `(() => {
  const h1 = [...document.querySelectorAll("h1")].map((e) => e.textContent.trim()).find(Boolean) || null;
  const addr = document.querySelector('[data-item-id="address"]');
  const address = addr ? (addr.getAttribute("aria-label") || addr.textContent || "").replace(/^Address:\\s*/, "").trim() || null : null;
  const links = [...document.querySelectorAll('a[href*="/maps/place/"]')]
    .map((a) => ({ label: a.getAttribute("aria-label") || "", href: a.href }));
  const feed = document.querySelector('[role="feed"]');
  const missed = /can't find|did not match any/i.test(document.body.innerText.slice(0, 4000));
  const kind = feed && links.length ? "list" : location.pathname.includes("/maps/place/") && h1 ? "place" : missed ? "none" : null;
  return { kind, name: kind === "place" ? h1 : null, address: kind === "place" ? address : null, links };
})()`;

async function landed(fp: FlowPage): Promise<RawPlace> {
  let raw: RawPlace = { kind: null, name: null, address: null, links: [] };
  for (let t = 0; t < LAND_MS; t += SETTLE_MS) {
    raw = await fp.page.evaluate<RawPlace>(PLACE_SCRIPT);
    if (raw.kind) return raw;
    await fp.wait(SETTLE_MS);
  }
  return raw;
}

export const googlePlace = defineFlow<PlaceInput, Place>({
  site: "web",
  name: "google-place",
  async run(fp, input) {
    const q = input.q.trim();
    if (!q) throw new Error("google-place: q is empty");
    // The Place ID is only in Maps' own search responses: keep them as they come.
    const bodies: string[] = [];
    fp.page.on("response", (res) => {
      if (!/\/search\?tbm=map|\/maps\/preview\/place/.test(res.url())) return;
      res.text().then(
        (t) => bodies.push(t),
        () => undefined,
      );
    });
    await fp.open(placeSearchUrl(q));
    if (await fp.has({ role: "button", name: "/^accept all$/i" }, 1_000))
      await fp.act(
        { kind: "click" },
        { role: "button", name: "/^accept all$/i" },
        { goal: "cookies" },
      );
    const raw = await landed(fp);
    if (raw.kind === null) throw new Error(`google-place: no Maps answer at ${fp.url()}`);
    // A place page's response may still be on its way.
    for (let t = 0; raw.kind === "place" && !bodies.length && t < LAND_MS; t += SETTLE_MS)
      await fp.wait(SETTLE_MS);
    return placeOf(q, fp.url(), raw, bodies);
  },
});
