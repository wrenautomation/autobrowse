/**
 * A browser flow is a typed function over a logged-in page: input in,
 * result out, `NeedsHuman` when a person must step in. The runner around
 * it is the same for every flow: one session per run, one flow per site at
 * a time (a profile cannot be open twice), a Playwright trace of every run
 * that goes wrong, a screenshot on the way out. A step that runs a flow
 * still proves the result through an API read afterwards where one exists;
 * the trace is for the person, the API read is for the machine.
 *
 * Flows are transcribed from recordings (`autobrowse record <site> --flow
 * <name>` runs Playwright codegen on the site's profile). The recording is
 * raw and may hold typed secrets; it stays out of git. What goes in is the
 * typed flow with visible-label selectors, so a redesign fails loudly.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { expandHome } from "../google-auth.js";
import { KeyedMutex } from "./lock.js";
import { type BrowserOptions, looksLikeWall, NeedsHuman, openSession } from "./session.js";

export type Site = "cloudflare" | "google-admin" | "instantly";

export const SITES: Record<Site, { home: string }> = {
  cloudflare: { home: "https://dash.cloudflare.com/" },
  "google-admin": { home: "https://admin.google.com/" },
  instantly: { home: "https://app.instantly.ai/" },
};

/** What a flow body gets: the page, plus the two things every flow does. */
export interface FlowPage {
  page: Page;
  /** Navigate, then refuse to continue past a login/captcha wall. */
  open(url: string): Promise<void>;
  /** Stop here and ask a person. */
  human(reason: string): never;
}

export interface BrowserFlow<I, O> {
  site: Site;
  /** Unique per site; names the trace files and the fake in tests. */
  name: string;
  run(fp: FlowPage, input: I): Promise<O>;
}

export function defineFlow<I, O>(flow: BrowserFlow<I, O>): BrowserFlow<I, O> {
  return flow;
}

export interface FlowRunner {
  run<I, O>(flow: BrowserFlow<I, O>, input: I): Promise<O>;
}

/** A flow threw something other than NeedsHuman; the artifacts say where. */
export class FlowFailed extends Error {
  constructor(
    flow: string,
    cause: unknown,
    readonly artifacts: { screenshot?: string; trace?: string },
  ) {
    super(`${flow}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "FlowFailed";
  }
}

export function flowRunner(opts: BrowserOptions, locks = new KeyedMutex()): FlowRunner {
  const artifactsDir = expandHome(opts.artifactsDir);
  return {
    run: (flow, input) =>
      locks.withLock(flow.site, async () => {
        const session = await openSession(flow.site, opts);
        const stamp = `${flow.site}-${flow.name}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        mkdirSync(artifactsDir, { recursive: true });
        // Tracing is best effort: a CDP-attached context may refuse it.
        const tracing = await session.context.tracing
          .start({ screenshots: true, snapshots: true })
          .then(() => true)
          .catch(() => false);
        const fp: FlowPage = {
          page: session.page,
          async open(url) {
            await session.page.goto(url, { waitUntil: "domcontentloaded" });
            const wall = await looksLikeWall(session.page);
            if (wall) throw new NeedsHuman(`${flow.site}: ${wall}`);
          },
          human(reason) {
            throw new NeedsHuman(`${flow.site}: ${reason}`);
          },
        };
        try {
          return await flow.run(fp, input);
        } catch (err) {
          const artifacts: { screenshot?: string; trace?: string } = {};
          const shot = join(artifactsDir, `${stamp}.png`);
          if (
            await session.page.screenshot({ path: shot, fullPage: true }).then(
              () => true,
              () => false,
            )
          )
            artifacts.screenshot = shot;
          if (tracing) {
            const trace = join(artifactsDir, `${stamp}.zip`);
            if (
              await session.context.tracing.stop({ path: trace }).then(
                () => true,
                () => false,
              )
            )
              artifacts.trace = trace;
          }
          if (err instanceof NeedsHuman) {
            err.artifacts = artifacts;
            throw err;
          }
          throw new FlowFailed(`${flow.site}/${flow.name}`, err, artifacts);
        } finally {
          if (tracing) await session.context.tracing.stop().catch(() => undefined);
          await session.close();
        }
      }),
  };
}
