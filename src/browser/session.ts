/**
 * One browser session per flow. Local: a persistent Chromium profile per
 * site, so a login done once (by hand, in `provision record`) is still there
 * next run. Browserbase: a persistent context on their side, same idea.
 *
 * A flow that hits a login page, a captcha or a phone check does not guess:
 * it throws `NeedsHuman` with a screenshot, the run parks at a gate, and
 * resumes after the human did the thing.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { expandHome } from "../google-auth.js";

export class NeedsHuman extends Error {
  readonly screenshot: string | null;
  constructor(reason: string, screenshot: string | null = null) {
    super(reason);
    this.name = "NeedsHuman";
    this.screenshot = screenshot;
  }
}

export interface BrowserOptions {
  tier: "local" | "browserbase";
  profilesDir: string;
  headless?: boolean;
  browserbase?: { apiKey: string; projectId: string } | null;
}

export interface Session {
  page: Page;
  /** Full-page PNG under the profiles dir; returns its path. */
  screenshot(label: string): Promise<string>;
  close(): Promise<void>;
}

export async function openSession(site: string, opts: BrowserOptions): Promise<Session> {
  const root = expandHome(opts.profilesDir);
  const shots = join(root, "screenshots");
  mkdirSync(shots, { recursive: true });
  let context: BrowserContext;
  let browser: Browser | null = null;
  if (opts.tier === "browserbase") {
    if (!opts.browserbase)
      throw new Error("BROWSER=browserbase needs BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID");
    const contextId = await browserbaseContext(site, opts.browserbase);
    const session = await browserbaseSession(opts.browserbase, contextId);
    browser = await chromium.connectOverCDP(session.connectUrl);
    context = browser.contexts()[0] ?? (await browser.newContext());
  } else {
    context = await chromium.launchPersistentContext(join(root, site), {
      headless: opts.headless ?? true,
      viewport: { width: 1280, height: 900 },
    });
  }
  const page = context.pages()[0] ?? (await context.newPage());
  return {
    page,
    async screenshot(label) {
      const path = join(shots, `${site}-${label}-${Date.now()}.png`);
      await page.screenshot({ path, fullPage: true });
      return path;
    },
    async close() {
      await context.close();
      await browser?.close();
    },
  };
}

// --- Browserbase: persistent contexts keyed by site name -------------------

const BB = "https://api.browserbase.com/v1";
const contextIds = new Map<string, string>();

async function browserbaseContext(
  site: string,
  bb: { apiKey: string; projectId: string },
): Promise<string> {
  const known = contextIds.get(site) ?? process.env[`BROWSERBASE_CONTEXT_${site.toUpperCase()}`];
  if (known) return known;
  const r = await fetch(`${BB}/contexts`, {
    method: "POST",
    headers: { "x-bb-api-key": bb.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ projectId: bb.projectId }),
  });
  if (!r.ok) throw new Error(`browserbase create context: HTTP ${r.status}`);
  const { id } = (await r.json()) as { id: string };
  contextIds.set(site, id);
  return id;
}

async function browserbaseSession(bb: { apiKey: string; projectId: string }, contextId: string) {
  const r = await fetch(`${BB}/sessions`, {
    method: "POST",
    headers: { "x-bb-api-key": bb.apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      projectId: bb.projectId,
      browserSettings: { context: { id: contextId, persist: true } },
    }),
  });
  if (!r.ok) throw new Error(`browserbase create session: HTTP ${r.status}`);
  return (await r.json()) as { id: string; connectUrl: string };
}

/** The page shows a login, captcha or verification wall. */
export async function looksLikeWall(page: Page): Promise<string | null> {
  const url = page.url();
  if (/accounts\.google\.com|\/login|\/sign-in|signin/i.test(url)) return `login page: ${url}`;
  const text = (
    await page
      .locator("body")
      .innerText()
      .catch(() => "")
  ).slice(0, 4000);
  if (/verify you are human|captcha|unusual traffic/i.test(text)) return "captcha";
  if (/verify your phone|enter the code|2-step verification/i.test(text))
    return "verification challenge";
  return null;
}
