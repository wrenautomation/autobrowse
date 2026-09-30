/**
 * The open web as a site, so a caller that only reaches autobrowse through
 * the facade (wren's worker, over Restate) can search and read: `GET
 * /search?q=` and `GET /read?url=`. No official API behind it; each route
 * tries its backends in order (`src/reach/web.ts`), and each backend reads
 * its own key by name (EXA_API_KEY, BRAVE_API_KEY, JINA_API_KEY), skipped
 * when unset. `via` reorders them for one call. `GET /google` is Google's own
 * page read in a browser (`browser/flows/google-search.ts`): the AI Overview,
 * every result, the ads. Google bot-checks the box's IP, so callers send it
 * to the Mac's desk (`desk/call`), paced like a person searching.
 */
import { z } from "zod";
import { readPage, search, WebMiss } from "../reach/web.js";
import { route, type SiteApi, SiteError } from "./types.js";

/** No backend answering is the caller's to read, not a retry: Restate would replay it forever. */
const final = (e: unknown): never => {
  throw e instanceof WebMiss ? new SiteError(e.status, e.message) : e;
};

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
  // Only the browser leg is paced and capped: the API backends meter themselves.
  caps: { google: 300 },
  pace: { gapMs: 5_000, jitterMs: 10_000 },
  routes: [
    route({
      method: "GET",
      path: "/search",
      summary:
        "Web search (`q`, `n` results, default 10): title, url, snippet; exa, then brave, then duckduckgo (`via` reorders)",
      request: z.object({
        q: z.string().min(1),
        n: z.coerce.number().int().min(1).max(50).default(10),
        via: order,
      }),
      api: ({ q, n, via }, leg) =>
        search(q, { env: async (k) => leg.env(k) }, { n, ...(via ? { order: via } : {}) }).catch(
          final,
        ),
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
          { env: async (k) => leg.env(k) },
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
  ],
  setup: [],
};
