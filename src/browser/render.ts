/**
 * The render and exit rungs of the fetch ladder (`reach/ladder.ts`): one page
 * in a stealth browser. Profile `fetch` leaves on the machine's own line;
 * `fetch@exit` leaves by the exit `EGRESS_SITES=fetch@exit:<name>` maps to it
 * (none mapped: `NoExit`, and the ladder stops with block `no-exit`).
 * The browser opens through `openSession`, like every autobrowse browser, and
 * stays warm in the `SessionPark` under its profile key. One render at a time
 * per profile. Nothing is blocked from loading: the page must look like a person's.
 * A challenge page gets up to 15 s to clear itself. No captcha solver here.
 */
import type { Response as PwResponse } from "playwright";
import { challengeOf, NoExit } from "../reach/ladder.js";
import { KeyedMutex } from "./lock.js";
import type { SessionPark } from "./park.js";
import { type BrowserOptions, openSession } from "./session.js";

export type RenderProfile = "fetch" | "fetch@exit";

export interface RenderedPage {
  finalUrl: string;
  /** The last document response's status (after a challenge cleared, the page's). */
  status: number | null;
  type: string | null;
  html: string;
}

/** What `ApiLeg.render` is. Throws `NoExit` for `fetch@exit` with no exit mapped. */
export type Render = (url: string, o: { profile: RenderProfile }) => Promise<RenderedPage>;

const NAV_MS = 45_000;
const CLEAR_POLLS = 15;
const CLEAR_EVERY_MS = 1_000;

/** Reads the page until no challenge marker shows, or the polls run out; returns the last read. */
export async function clearChallenge(
  read: () => Promise<RenderedPage>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<RenderedPage> {
  let page = await read();
  for (let i = 0; i < CLEAR_POLLS && challengeOf(page); i++) {
    await sleep(CLEAR_EVERY_MS);
    page = await read();
  }
  return page;
}

export interface RenderDeps {
  opts: BrowserOptions;
  /** Without a park the browser closes after each render. */
  park?: SessionPark;
  locks?: KeyedMutex;
  sleep?: (ms: number) => Promise<void>;
}

export function renderer(deps: RenderDeps): Render {
  const { opts, park } = deps;
  const locks = deps.locks ?? new KeyedMutex();
  return async (url, { profile }) => {
    if (profile === "fetch@exit" && !opts.egress?.exitFor(profile)) throw new NoExit();
    // The same key flows use for a park slot (`browser/flow.ts`).
    const key = (await opts.profileName?.(profile)) ?? profile;
    return locks.withLock(key, async () => {
      const session = (await park?.take(key)) ?? (await openSession(profile, opts));
      let healthy = false;
      try {
        const page = await session.context.newPage();
        try {
          let last: PwResponse | null = null;
          page.on("response", (r) => {
            if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) last = r;
          });
          await page.goto(url, { waitUntil: "load", timeout: NAV_MS });
          const read = async (): Promise<RenderedPage> => ({
            finalUrl: page.url(),
            status: last?.status() ?? null,
            type: last?.headers()["content-type"] ?? null,
            // A challenge reloads the page under us: wait it out once, then read again.
            html: await page.content().catch(async () => {
              await page.waitForLoadState("domcontentloaded").catch(() => undefined);
              return page.content();
            }),
          });
          const got = await clearChallenge(read, deps.sleep);
          healthy = true;
          return got;
        } finally {
          await page.close().catch(() => undefined);
        }
      } finally {
        if (healthy && park) await park.put(key, session);
        else await session.close().catch(() => undefined);
      }
    });
  };
}
