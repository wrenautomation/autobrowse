/**
 * One browser session per flow run. Local: a persistent Chromium profile
 * per site, so a login done once by hand (`autobrowse record <site>`) is
 * still there next run. Browserbase: a persistent context on their side,
 * same idea. Either way the session is opened for one flow and closed
 * after it; `flow.ts` decides when and holds the per-site lock.
 */
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import type { HttpClient } from "../clients/http.js";
import { expandHome } from "../google-auth.js";

/** A page needs a person: login, captcha, consent, or a layout nobody planned for. */
export class NeedsHuman extends Error {
  /** Set by the runner, not the flow: where the screenshot and trace went. */
  artifacts: Artifacts = {};
  constructor(reason: string) {
    super(reason);
    this.name = "NeedsHuman";
  }
}

export interface Artifacts {
  screenshot?: string;
  trace?: string;
}

export type Tier = "local" | "browserbase";

export interface BrowserOptions {
  tier: Tier;
  profilesDir: string;
  artifactsDir: string;
  headless?: boolean;
  /**
   * Which local browser: "chrome" (the installed Google Chrome, what a
   * person's login looks like) or "chromium" (Playwright's bundle, what a
   * container has). "chrome" falls back to chromium when none is installed.
   */
  channel?: "chrome" | "chromium";
  browserbase?: { apiKey: string; projectId: string; http: HttpClient } | null;
}

export interface Session {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

export async function openSession(site: string, opts: BrowserOptions): Promise<Session> {
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
    context = await launchLocal(join(expandHome(opts.profilesDir), site), opts);
    // Sites read `navigator.webdriver` to refuse "insecure" browsers; these are our own accounts.
    await context.addInitScript(
      "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });",
    );
  }
  const page = context.pages()[0] ?? (await context.newPage());
  return {
    context,
    page,
    async close() {
      await context.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    },
  };
}

/** Launch flags that keep a site from telling the browser apart from a person's. */
const LOCAL_ARGS = ["--disable-blink-features=AutomationControlled"];

async function launchLocal(profileDir: string, opts: BrowserOptions): Promise<BrowserContext> {
  const base = {
    headless: opts.headless ?? true,
    viewport: { width: 1280, height: 900 },
    args: LOCAL_ARGS,
    ignoreDefaultArgs: ["--enable-automation"],
  };
  if (opts.channel !== "chromium") {
    try {
      return await chromium.launchPersistentContext(profileDir, { ...base, channel: "chrome" });
    } catch (err) {
      if (!/executable doesn't exist|chrome/i.test(err instanceof Error ? err.message : ""))
        throw err;
    }
  }
  return chromium.launchPersistentContext(profileDir, base);
}

// --- Browserbase: persistent contexts keyed by site name -------------------

const BB = "https://api.browserbase.com/v1";
const contextIds = new Map<string, string>();

type Browserbase = NonNullable<BrowserOptions["browserbase"]>;

async function browserbaseContext(site: string, bb: Browserbase): Promise<string> {
  const known = contextIds.get(site) ?? process.env[`BROWSERBASE_CONTEXT_${site.toUpperCase()}`];
  if (known) return known;
  const r = await bb.http.json<{ id: string }>(`${BB}/contexts`, {
    method: "POST",
    headers: { "x-bb-api-key": bb.apiKey },
    body: { projectId: bb.projectId },
  });
  if (!r.ok || !r.body) throw new Error(`browserbase create context: HTTP ${r.status}`);
  contextIds.set(site, r.body.id);
  return r.body.id;
}

async function browserbaseSession(bb: Browserbase, contextId: string) {
  const r = await bb.http.json<{ id: string; connectUrl: string }>(`${BB}/sessions`, {
    method: "POST",
    headers: { "x-bb-api-key": bb.apiKey },
    body: {
      projectId: bb.projectId,
      browserSettings: { context: { id: contextId, persist: true } },
    },
  });
  if (!r.ok || !r.body) throw new Error(`browserbase create session: HTTP ${r.status}`);
  return r.body;
}

/** The page shows a login, captcha or verification wall. */
export interface Wall {
  /** `login` and `challenge` can be solved with credentials and codes; `captcha` still needs a person (or Browserbase). */
  kind: "login" | "challenge" | "captcha";
  detail: string;
}

export async function looksLikeWall(page: Page): Promise<Wall | null> {
  const url = page.url();
  if (/accounts\.google\.com|\/login|\/sign-in|signin/i.test(url))
    return { kind: "login", detail: `login page: ${url}` };
  const text = (
    await page
      .locator("body")
      .innerText()
      .catch(() => "")
  ).slice(0, 4000);
  if (/verify you are human|captcha|unusual traffic/i.test(text))
    return { kind: "captcha", detail: "captcha" };
  if (/verify your phone|enter the code|2-step verification/i.test(text))
    return { kind: "challenge", detail: "verification challenge" };
  return null;
}
