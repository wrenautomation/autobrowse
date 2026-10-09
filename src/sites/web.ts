/**
 * The open web as a site, so a caller that only reaches autobrowse through
 * the facade (wren's worker, over Restate) can search and read: `GET
 * /search?q=`, `GET /people?q=` and `GET /read?url=`. No official API behind it; each route
 * tries its backends in order (`src/reach/web.ts`), and each backend reads
 * its own key by name (EXA_API_KEY, BRAVE_API_KEY, JINA_API_KEY), skipped
 * when unset. `via` reorders them for one call. `GET /google` is Google's own
 * page read in a browser (`browser/flows/google-search.ts`): the AI Overview,
 * every result, the ads. Google bot-checks the box's IP, so callers send it
 * to the Mac's desk (`desk/call`), paced like a person searching. `GET /place` is a
 * business's Place ID off Google Maps the same way (`browser/flows/google-place.ts`), and
 * `GET /place/reviews` its reviews, signed in (`browser/flows/google-reviews.ts`).
 *
 * LinkedIn without LinkedIn: `GET /linkedin/profile?url=` and
 * `/linkedin/company?url=` read Exa's cached copy (never live, so neither
 * LinkedIn nor Exa's crawler visits), in the `linkedin` site's shapes;
 * `GET /companies?domain=` finds a firm's company page; `GET /exa/companies?q=` lists the firms
 * for a niche and city search. Exa bills in dollars,
 * so its routes share one daily budget in mills ($0.001): `exa`, 330 a day
 * (about $10 a month, its free credit). Raising it is a spend decision.
 */
import { z } from "zod";
import { MAX_REVIEWS } from "../browser/flows/google-reviews.js";
import {
  cachedLinkedinCompany,
  cachedLinkedinProfile,
  companies,
  companySearch,
  hostOf,
  linkedinPosts,
  linkedinSlug,
  people,
  readPage,
  search,
  WebMiss,
} from "../reach/web.js";
import { route, type SiteApi, SiteError } from "./types.js";

/** No backend answering is the caller's to read, not a retry: Restate would replay it forever. */
const final = (e: unknown): never => {
  throw e instanceof WebMiss ? new SiteError(e.status, e.message) : e;
};

/** Checked before the meter, so a bad URL spends none of the budget. */
const pageOf = (kind: "in" | "company") =>
  z.string().refine(
    (v) => {
      try {
        linkedinSlug(v, kind);
        return true;
      } catch {
        return false;
      }
    },
    { message: `url: want a linkedin.com/${kind}/ page` },
  );

const order = z
  .string()
  .optional()
  .transform((v) => {
    const list = v
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return list?.length ? list : undefined; // `via=,` means the default order
  });

export const web: SiteApi = {
  site: "web",
  origin: "https://web",
  auth: { open: true },
  signedOut: true,
  // Google's page is capped in searches; Exa in mills of a dollar. /search's backends meter themselves.
  caps: { google: 300, exa: 330 },
  // 330 mills ($0.33) a day per live Exa key: each key's free $10 a month gets used.
  capsPerKey: { exa: "EXA" },
  pace: { gapMs: 5_000, jitterMs: 10_000 },
  routes: [
    route({
      method: "GET",
      path: "/search",
      summary:
        "Web search (`q`, `n` results, default 10): title, url, snippet and the backend's whole result as `raw`; exa, then brave, then duckduckgo (`via` reorders)",
      request: z.object({
        q: z.string().min(1),
        n: z.coerce.number().int().min(1).max(50).default(10),
        via: order,
      }),
      api: ({ q, n, via }, leg) =>
        search(
          q,
          { env: async (k) => leg.env(k), ...(leg.spent ? { spent: leg.spent } : {}) },
          { n, ...(via ? { order: via } : {}) },
        ).catch(final),
    }),
    route({
      method: "GET",
      path: "/people",
      summary:
        "People search (`q`, `n` people, default 10): public profiles with name, headline, location and every role (title, company, current, dates), and every result Exa sent as `raw`; exa",
      request: z.object({
        q: z.string().min(1),
        n: z.coerce.number().int().min(1).max(25).default(10),
      }),
      meter: () => ({ exa: 7 }),
      api: ({ q, n }, leg) =>
        people(
          q,
          { env: async (k) => leg.env(k), ...(leg.spent ? { spent: leg.spent } : {}) },
          { n },
        ).catch(final),
    }),
    route({
      method: "GET",
      path: "/companies",
      summary:
        "Companies Exa holds for a domain (`domain`, `n` up to 10, default 3): name, website, industry, size, headquarters, founded, phone, LinkedIn page when linked, `homepageMatches`, and every result Exa sent as `raw`; exa, 7 of the `exa` budget",
      request: z.object({
        domain: z
          .string()
          .refine((v) => hostOf(v).includes("."), { message: "domain: want one like acme.com" }),
        n: z.coerce.number().int().min(1).max(10).default(3),
      }),
      meter: () => ({ exa: 7 }),
      api: ({ domain, n }, leg) =>
        companies(
          domain,
          { env: async (k) => leg.env(k), ...(leg.spent ? { spent: leg.spent } : {}) },
          { n },
        ).catch(final),
    }),
    route({
      method: "GET",
      path: "/exa/companies",
      summary:
        "Firms Exa's company index lists for a search (`q` like \"staffing agency in Austin\", `n` up to 25, default 10): each result's url, title, domain and `raw` (every field Exa sent), no page text; exa, 7 of the `exa` budget a search whatever `n`",
      request: z.object({
        q: z.string().min(1),
        n: z.coerce.number().int().min(1).max(25).default(10),
      }),
      meter: () => ({ exa: 7 }),
      api: ({ q, n }, leg) =>
        companySearch(
          q,
          { env: async (k) => leg.env(k), ...(leg.spent ? { spent: leg.spent } : {}) },
          { n },
        ).catch(final),
    }),
    route({
      method: "GET",
      path: "/linkedin/profile",
      summary:
        "A LinkedIn profile from Exa's cache, never fetched live (`url`): `linkedin GET /in/{vanity}`'s shape with roles, plus education and the raw `text`; 404 when Exa holds no copy. 1 of the `exa` budget",
      request: z.object({ url: pageOf("in") }),
      meter: () => ({ exa: 1 }),
      api: ({ url }, leg) =>
        cachedLinkedinProfile(url, {
          env: async (k) => leg.env(k),
          ...(leg.spent ? { spent: leg.spent } : {}),
        }).catch(final),
    }),
    route({
      method: "GET",
      path: "/linkedin/company",
      summary:
        "A LinkedIn company page from Exa's cache, never fetched live (`url`): `linkedin GET /company/{company}`'s shape plus type, employees, about and the raw `text`; 404 when Exa holds no copy. 1 of the `exa` budget",
      request: z.object({ url: pageOf("company") }),
      meter: () => ({ exa: 1 }),
      api: ({ url }, leg) =>
        cachedLinkedinCompany(url, {
          env: async (k) => leg.env(k),
          ...(leg.spent ? { spent: leg.spent } : {}),
        }).catch(final),
    }),
    route({
      method: "GET",
      path: "/linkedin/posts",
      summary:
        'Public LinkedIn posts from Exa\'s index, never fetched live (`q` like "Avery Quinlan Northwind", `n` up to 25, default 10, `since` an ISO date): url, title, author, publishedDate, text and `raw`; only `linkedin.com/posts` urls. 7 of the `exa` budget',
      request: z.object({
        q: z.string().min(1),
        n: z.coerce.number().int().min(1).max(25).default(10),
        since: z.iso.date().optional(),
      }),
      meter: () => ({ exa: 7 }),
      api: ({ q, n, since }, leg) =>
        linkedinPosts(
          q,
          { env: async (k) => leg.env(k), ...(leg.spent ? { spent: leg.spent } : {}) },
          { n, ...(since ? { since } : {}) },
        ).catch(final),
    }),
    route({
      method: "GET",
      path: "/read",
      summary:
        "One page as lean text (`url`, `max` characters, default 20000): jina, then a plain fetch (`via` reorders)",
      request: z.object({
        url: z.string().url(),
        max: z.coerce.number().int().min(500).max(200_000).default(20_000),
        via: order,
      }),
      api: ({ url, max, via }, leg) =>
        readPage(
          url,
          { env: async (k) => leg.env(k), ...(leg.spent ? { spent: leg.spent } : {}) },
          { max, ...(via ? { order: via } : {}) },
        ).catch(final),
    }),
    route({
      method: "GET",
      path: "/google",
      summary:
        "Google's page for `q` (`n` results, default 10, up to 30; `gl` country, `hl` language): the AI Overview and its sources, every organic result, ads, People also ask. A browser leg: call it on the desk",
      request: z.object({
        q: z.string().min(1),
        n: z.coerce.number().int().min(1).max(30).default(10),
        hl: z
          .string()
          .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
          .optional(),
        gl: z
          .string()
          .regex(/^[a-z]{2}$/)
          .optional(),
      }),
      meter: ({ n }) => ({ google: Math.ceil(n / 10) }),
      browser: { flow: "web/google" },
    }),
    route({
      method: "GET",
      path: "/place",
      summary:
        "A business's Google Place ID from Google Maps, signed out (`q`: name and address, \"Northwind Plumbing, 12 Elm St, Springfield\"): `placeId` (null when no place carries the name), `name`, `address`, `url`, `via` (place, list or none) and the list's `candidates`. A browser leg: call it on the desk",
      request: z.object({ q: z.string().trim().min(3).max(300) }),
      meter: () => ({ google: 1 }),
      browser: { flow: "web/google-place" },
    }),
    route({
      method: "GET",
      path: "/place/reviews",
      summary:
        "A place's Google reviews off Google Maps, newest first (`placeId`, `limit` up to 50, default 20): `name`, `url` (the place on Maps) and `reviews`, each with `id`, `author`, `authorUrl`, `stars`, `text`, `at` (ISO), `ago`, `edited` and the owner's `reply`. Signed out Maps hides reviews, so it reads in the `google` profile. A browser leg: call it on the desk",
      request: z.object({
        placeId: z.string().regex(/^[A-Za-z0-9_-]{16,200}$/),
        limit: z.coerce.number().int().min(1).max(MAX_REVIEWS).default(20),
      }),
      meter: () => ({ google: 1 }),
      browser: { flow: "google/maps-reviews", signedIn: true },
    }),
  ],
  setup: [],
};
