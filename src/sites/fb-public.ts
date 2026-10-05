/**
 * Facebook's public pages, read signed out: never Wren's Meta login (it runs our ads, and
 * Meta bans accounts that scrape). Each route is a built walk on the owner's Mac
 * (`walks/fb-public/<name>.json`, a `records` op, designs/2026-10-05-records-and-ai-steps.md),
 * so call it on the desk. `GET /ads?q=` is the Ad Library: ads running now for a keyword,
 * with the advertiser's page and the link each ad sends to. The Ad Library API only covers
 * political ads outside the EU, so this is the browser read.
 */
import { z } from "zod";
import type { WalkOutput } from "../walks/flow.js";
import { route, type SiteApi } from "./types.js";

export const fbPublic: SiteApi = {
  site: "fb-public",
  origin: "https://www.facebook.com",
  auth: { open: true },
  signedOut: true,
  // About 30 ads a read; a person browsing the library doesn't load hundreds of pages a day.
  caps: { reads: 200 },
  pace: { gapMs: 20_000, jitterMs: 20_000 },
  routes: [
    route({
      method: "GET",
      path: "/ads",
      summary:
        "Ads running now for keyword `q` in `country` (default US), newest layout first: Library ID, advertiser, its page, start date, text, call to action, the link it sends to (`url`, every one in `urls`), the shown domain (`caption`), and the card's whole text (`all`). A browser leg: call it on the desk",
      request: z.object({
        q: z.string().trim().min(2).max(100),
        country: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .default("US"),
      }),
      meter: () => ({ reads: 1 }),
      browser: {
        flow: "fb-public/walk-ad-library",
        output: (o) => ({ ads: (o as WalkOutput).records.ads ?? [] }),
      },
    }),
  ],
  setup: [],
};
