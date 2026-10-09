/**
 * A place's Google reviews off Google Maps, newest first (`web GET /place/reviews`). wren reads a
 * client's reviews this way when its Business Profile isn't reading them, and drafts a reply to
 * each (wren designs/2026-10-09-review-replies.md).
 *
 * Mapped 2026-10-09. Signed out, Maps shows a place with no Reviews tab and its review list
 * answers 403, so this runs in the `google` profile (Wren's own account). The place opens from
 * its Place ID (`/maps/place/?q=place_id:…`). The Reviews tab lists reviews as
 * `[data-review-id]` blocks (nested blocks repeat the id): the name on `.d4r55`, the profile on
 * the name button's `data-href`, the stars in `[role=img]`'s `aria-label` ("4 stars"), the age
 * as words on `.rsqaWe`. A hotel shows them as "4/5" (`.fzvQIb`) and "2 hours ago on Google"
 * (`.xRkPPb`), with other sites' reviews in the same list. The words on `.wiI7pd`, and the owner's answer in `.CDe7pd` (its own
 * `.wiI7pd`, its age on `.DZSIDd`). "More" buttons (`aria-label="See more"`) cut long words
 * until pressed. The exact time is only in the list's response (`batchexecute`, rpc `qv9Egd`),
 * as `"<review id>",["0x…:0x…",null,<created µs>,<updated µs>`, so the flow keeps those.
 */
import { defineFlow, type FlowPage } from "../flow.js";
import { MAPS } from "./google-place.js";

const LAND_MS = 15_000;
const SETTLE_MS = 800;
/** Scrolls with no new review before the list counts as done. */
const STILL_ROUNDS = 3;
export const MAX_REVIEWS = 50;
const MORE_ROUNDS = 40;
const TAB_TRIES = 3;
/** The tab's name is "Reviews for <place>"; its text is "Reviews". */
const REVIEWS_TAB = { role: "tab", name: "/^reviews( for .*)?$/i" } as const;
/** The sort button: named "Sort reviews" on some places, by the order it holds on others. */
const SORT = {
  role: "button",
  name: "/^(sort( reviews)?|most relevant|newest|highest rating|lowest rating)$/i",
} as const;

export interface ReviewsInput {
  placeId: string;
  /** Newest first, up to `MAX_REVIEWS`. */
  limit?: number;
}

export interface MapsReview {
  /** Google's review id. */
  id: string;
  author: string;
  /** The reviewer's Maps profile. */
  authorUrl: string | null;
  /** 1 to 5; null when Maps showed none. */
  stars: number | null;
  /** Their words; empty for stars only. */
  text: string;
  /**
   * When they wrote it (ISO): exact from Maps' own response, or, where that isn't sent (a
   * hotel's list), counted back from `ago` and `estimated`. Null when neither reads.
   */
  at: string | null;
  estimated: boolean;
  /** Maps' words for the age: "3 months ago", "Edited a year ago". */
  ago: string;
  edited: boolean;
  /** The owner's answer, if any. */
  reply: { text: string; ago: string } | null;
}

export interface PlaceReviews {
  placeId: string;
  name: string | null;
  /** The place's page on Maps: where a person answers a review by hand. */
  url: string;
  reviews: MapsReview[];
}

/** What the page script reads per review. */
export interface RawReview {
  id: string;
  author: string;
  authorUrl: string | null;
  starsLabel: string | null;
  text: string;
  ago: string;
  reply: { text: string; ago: string } | null;
}

export const placeUrl = (placeId: string): string =>
  `${MAPS}/place/?${new URLSearchParams({ q: `place_id:${placeId}`, hl: "en" })}`;

/** "4 stars", "1 star", "4/5" → 4, 1, 4; anything else null. */
export function starsOf(label: string | null): number | null {
  const m = /^\s*([1-5])(?:\.0)?(?:\s+stars?\b|\s*\/\s*5\b)/i.exec(label ?? "");
  return m ? Number(m[1]) : null;
}

/** "2 hours ago on Google" → the age and where it was written; a bare age is Google's. */
export function agoOf(s: string): { ago: string; source: string } {
  const m = /^(.*?)\s+on\s+(\S.*)$/i.exec(s.trim());
  return m
    ? { ago: (m[1] as string).trim(), source: (m[2] as string).trim() }
    : { ago: s.trim(), source: "Google" };
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** When each review was written (ISO), by id, from Maps' list responses. */
export function timesIn(bodies: readonly string[], ids: readonly string[]): Map<string, string> {
  // The rpc nests its payload as a JSON string: unescape the quotes once.
  const text = bodies.join("\n").replace(/\\"/g, '"');
  const out = new Map<string, string>();
  for (const id of ids) {
    const m = new RegExp(
      `"${literal(id)}",\\["0x[0-9a-f]+:0x[0-9a-f]+",null,(\\d{13,17})`,
      "i",
    ).exec(text);
    if (!m) continue;
    const us = Number(m[1]);
    // Microseconds since 1970: 16 digits for any date this century.
    const ms = String(m[1]).length >= 16 ? us / 1000 : us;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) out.set(id, d.toISOString());
  }
  return out;
}

const UNIT_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
};

/** "3 weeks ago", "Edited a year ago" counted back from `now` (ISO), or null. */
export function agoAt(ago: string, now: Date): string | null {
  const m = /^(?:edited\s+)?(a|an|\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/i.exec(
    ago.trim(),
  );
  if (!m) return null;
  const n = /^an?$/i.test(m[1] as string) ? 1 : Number(m[1]);
  return new Date(now.getTime() - n * (UNIT_MS[(m[2] as string).toLowerCase()] ?? 0)).toISOString();
}

const tidy = (s: string) =>
  s
    .replace(/\s*…\s*More\s*$/, "")
    .replace(/\s+\n/g, "\n")
    .trim();

/**
 * The answer from what the page showed and what Maps sent: once per id, newest first as shown.
 * A hotel's list also carries reviews from other sites ("on Tripadvisor"); only Google's own are
 * kept, since only those are answered on Google.
 */
export function reviewsOf(
  raw: readonly RawReview[],
  bodies: readonly string[],
  limit: number,
  now: Date,
): MapsReview[] {
  const seen = new Set<string>();
  const rows = raw
    .filter((r) => r.id && !seen.has(r.id) && seen.add(r.id))
    .filter((r) => /^google$/i.test(agoOf(r.ago).source))
    .slice(0, limit);
  const at = timesIn(
    bodies,
    rows.map((r) => r.id),
  );
  return rows.map((r) => {
    const ago = agoOf(r.ago).ago;
    const exact = at.get(r.id) ?? null;
    return {
      id: r.id,
      author: r.author.trim(),
      authorUrl: r.authorUrl,
      stars: starsOf(r.starsLabel),
      text: tidy(r.text),
      at: exact ?? agoAt(ago, now),
      estimated: !exact,
      ago,
      edited: /^edited\b/i.test(ago),
      reply: r.reply?.text.trim() ? { text: tidy(r.reply.text), ago: r.reply.ago.trim() } : null,
    };
  });
}

/** The reviews shown: the outer `[data-review-id]` blocks only. */
export const REVIEWS_SCRIPT = `(() => [...document.querySelectorAll("[data-review-id]")]
  .filter((e) => !e.parentElement.closest("[data-review-id]"))
  .map((e) => {
    const own = e.querySelector(".CDe7pd");
    const words = [...e.querySelectorAll(".wiI7pd")].find((w) => !own || !own.contains(w));
    const name = e.querySelector(".d4r55");
    const link = e.querySelector("button[data-href*='/maps/contrib/']");
    const stars = e.querySelector("[role=img][aria-label*='star']");
    const score = e.querySelector(".fzvQIb");
    const ago = e.querySelector(".rsqaWe") || e.querySelector(".xRkPPb");
    const said = own && own.querySelector(".wiI7pd");
    return {
      id: e.getAttribute("data-review-id") || "",
      author: (name && name.textContent) || e.getAttribute("aria-label") || "",
      authorUrl: link ? link.getAttribute("data-href") : null,
      starsLabel: stars ? stars.getAttribute("aria-label") : score ? score.textContent : null,
      text: words ? words.innerText : "",
      ago: ago ? ago.textContent : "",
      reply: said ? { text: said.innerText, ago: (own.querySelector(".DZSIDd") || {}).textContent || "" } : null,
    };
  }))()`;

/** Press every "More" still shown; how many were pressed. */
const MORE_SCRIPT = `(() => {
  const b = [...document.querySelectorAll("[data-review-id] button[aria-label='See more'][aria-expanded='false']")];
  b.forEach((x) => x.click());
  return b.length;
})()`;

/** Scroll the list's own pane to its end; the count of reviews shown. */
const SCROLL_SCRIPT = `(() => {
  const first = document.querySelector("[data-review-id]");
  let p = first && first.parentElement;
  while (p && !(p.scrollHeight > p.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
  if (p) p.scrollTop = p.scrollHeight;
  return [...document.querySelectorAll("[data-review-id]")].filter((e) => !e.parentElement.closest("[data-review-id]")).length;
})()`;

const SHOWN_SCRIPT = `(() => ({
  name: [...document.querySelectorAll("h1")].map((e) => e.textContent.trim()).find(Boolean) || null,
  tabs: [...document.querySelectorAll("[role=tab]")].map((e) => e.textContent.trim()),
  signedOut: !!document.querySelector("a[href*='accounts.google.com/ServiceLogin']"),
}))()`;

interface Shown {
  name: string | null;
  tabs: string[];
  signedOut: boolean;
}

async function landed(fp: FlowPage): Promise<Shown> {
  let s: Shown = { name: null, tabs: [], signedOut: false };
  for (let t = 0; t < LAND_MS; t += SETTLE_MS) {
    s = await fp.page.evaluate<Shown>(SHOWN_SCRIPT);
    if (s.name && s.tabs.length) return s;
    await fp.wait(SETTLE_MS);
  }
  return s;
}

const shownCount = (fp: FlowPage) =>
  fp.page.evaluate<number>(
    `[...document.querySelectorAll("[data-review-id]")].filter((e) => !e.parentElement.closest("[data-review-id]")).length`,
  );

export const googleReviews = defineFlow<ReviewsInput, PlaceReviews>({
  site: "google",
  name: "maps-reviews",
  async run(fp, input) {
    const placeId = input.placeId.trim();
    if (!placeId) throw new Error("maps-reviews: placeId is empty");
    const limit = Math.min(Math.max(input.limit ?? 20, 1), MAX_REVIEWS);
    const bodies: string[] = [];
    fp.page.on("response", (res) => {
      if (!/batchexecute\?rpcids=[^&]*qv9Egd/.test(res.url())) return;
      res.text().then(
        (t) => bodies.push(t),
        () => undefined,
      );
    });
    await fp.open(placeUrl(placeId));
    if (await fp.has({ role: "button", name: "/^accept all$/i" }, 1_000))
      await fp.act(
        { kind: "click" },
        { role: "button", name: "/^accept all$/i" },
        { goal: "cookies" },
      );
    const shown = await landed(fp);
    const url = fp.url();
    if (!shown.name) throw new Error(`maps-reviews: no place at ${url}`);
    const none: PlaceReviews = { placeId, name: shown.name, url, reviews: [] };
    if (!shown.tabs.some((t) => /^reviews$/i.test(t))) {
      // Signed out, every place hides its reviews; signed in, no tab is no reviews.
      if (shown.signedOut)
        return fp.human("Maps shows no reviews signed out: sign the google profile in");
      return none;
    }
    // A click before the page settles does nothing: press again until the list shows.
    for (let i = 0; i < TAB_TRIES && !(await shownCount(fp)); i++) {
      await fp.act({ kind: "click" }, REVIEWS_TAB, { goal: "reviews" });
      for (let t = 0; t < LAND_MS / TAB_TRIES && !(await shownCount(fp)); t += SETTLE_MS)
        await fp.wait(SETTLE_MS);
    }
    if (!(await shownCount(fp))) return none;
    // Newest first: Maps opens on "Most relevant".
    if (await fp.has(SORT, 2_000)) {
      await fp.act({ kind: "click" }, SORT, { goal: "sort" });
      await fp.act(
        { kind: "click" },
        { role: "menuitemradio", name: "/^newest$/i" },
        { goal: "newest" },
      );
      bodies.length = 0;
      for (let t = 0; t < LAND_MS && !bodies.length; t += SETTLE_MS) await fp.wait(SETTLE_MS);
      await fp.wait(SETTLE_MS);
    }
    let count = await shownCount(fp);
    for (let still = 0; count < limit && still < STILL_ROUNDS; ) {
      const next = await fp.page.evaluate<number>(SCROLL_SCRIPT);
      await fp.wait(SETTLE_MS * 2);
      still = next > count ? 0 : still + 1;
      count = next;
    }
    for (let i = 0; i < MORE_ROUNDS; i++) {
      if (!(await fp.page.evaluate<number>(MORE_SCRIPT))) break;
      await fp.wait(SETTLE_MS / 2);
    }
    const raw = await fp.page.evaluate<RawReview[]>(REVIEWS_SCRIPT);
    return { ...none, reviews: reviewsOf(raw, bodies, limit, new Date()) };
  },
});
