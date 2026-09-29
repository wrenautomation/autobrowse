/**
 * The open web as a site, so a caller that only reaches autobrowse through
 * the facade (wren's worker, over Restate) can search and read: `GET
 * /search?q=` and `GET /read?url=`. No official API behind it; each route
 * tries its backends in order (`src/reach/web.ts`), and each backend reads
 * its own key by name (EXA_API_KEY, BRAVE_API_KEY, JINA_API_KEY), skipped
 * when unset. `via` reorders them for one call.
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
  .transform((v) =>
    v
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

export const web: SiteApi = {
  site: "web",
  origin: "https://web",
  auth: { open: true },
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
  ],
  setup: [],
};
