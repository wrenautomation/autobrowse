/**
 * One browser session per flow run. Local: a persistent Chromium profile
 * per site, so a login done once by hand (`autobrowse record <site>`) is
 * still there next run. Browserbase: a persistent context on their side,
 * same idea. Either way the session is opened for one flow and closed
 * after it; `flow.ts` decides when and holds the per-site lock.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import type { HttpClient } from "../clients/http.js";
import { expandHome } from "../google-auth.js";
import { type PasskeyRecord, type Passkeys, virtualAuthenticator } from "./webauthn.js";

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
  /** The accessibility tree as text, next to the PNG: every control by role and name. */
  aria?: string;
  trace?: string;
  /** The failure as data (site, flow, url, last goal, error): what `autobrowse repair` starts from. */
  failure?: string;
}

/** What a flow left behind when it stopped: enough for an agent to pick up where it fell. */
export interface FailureRecord {
  site: string;
  flow: string;
  url: string;
  /** The goal of the last act the flow attempted, when there was one. */
  goal: string | null;
  error: string;
  kind: "failed" | "human" | "interrupted";
  at: string;
  screenshot?: string;
  aria?: string;
}

/**
 * Where the browser is: launched here with a profile per site, a Browserbase
 * session, or a browser already running that the caller names by its CDP
 * endpoint (a Chrome with `--remote-debugging-port`, or an Electron app such
 * as the new Outlook, Slack, Notion started with it: the desktop leg for
 * apps that are web pages inside).
 */
export type Tier = "local" | "browserbase" | "cdp";

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
  /** `BROWSER=cdp`: the endpoint to attach to (`http://127.0.0.1:9222` or a `ws://` URL). */
  cdpUrl?: string | null;
  /** Passkeys to load into the site's session: the ones enrolled for its account. */
  passkeys?: (site: string) => Promise<readonly PasskeyRecord[]>;
  /**
   * The profile to work in, when it is not the site's own. A credential that
   * signs in through a provider's button belongs in that provider's profile:
   * the session Google already holds there answers the button, where a fresh
   * profile would ask for the password again.
   */
  profile?: string;
}

export interface Session {
  context: BrowserContext;
  page: Page;
  /** The virtual authenticator: export after an enrollment. */
  passkeys: Passkeys;
  close(): Promise<void>;
}

export async function openSession(site: string, opts: BrowserOptions): Promise<Session> {
  let context: BrowserContext;
  let browser: Browser | null = null;
  if (opts.tier === "browserbase") {
    if (!opts.browserbase)
      throw new Error("BROWSER=browserbase needs BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID");
    const contextId = await browserbaseContext(opts.profile ?? site, opts.browserbase);
    const session = await browserbaseSession(opts.browserbase, contextId);
    browser = await chromium.connectOverCDP(session.connectUrl);
    context = browser.contexts()[0] ?? (await browser.newContext());
  } else if (opts.tier === "cdp") {
    if (!opts.cdpUrl) throw new Error("BROWSER=cdp needs BROWSER_CDP_URL");
    // The app's own context and pages: nothing is launched, nothing closed on our way out.
    browser = await chromium.connectOverCDP(opts.cdpUrl);
    context = browser.contexts()[0] ?? (await browser.newContext());
  } else {
    const profileDir = join(expandHome(opts.profilesDir), opts.profile ?? site);
    context = await launchLocal(profileDir, opts);
    if (opts.headless === false) keepOutOfTheWay(profileDir);
    // Sites read `navigator.webdriver` to refuse "insecure" browsers; these are our own accounts.
    await context.addInitScript(
      "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });",
    );
  }
  const page = context.pages()[0] ?? (await context.newPage());
  const passkeys = virtualAuthenticator(context, await opts.passkeys?.(site).catch(() => []));
  return {
    context,
    page,
    passkeys,
    async close() {
      // An attached app keeps its windows; only what we launched or rented closes.
      if (opts.tier === "cdp") {
        await browser?.close().catch(() => undefined);
        return;
      }
      await context.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    },
  };
}

/**
 * A headed Chrome on a laptop someone is using: hide its windows (they
 * still render, and bot checks still pass) and give focus back to the app
 * that had it. Best effort; only macOS has the tools.
 */
function keepOutOfTheWay(profileDir: string): void {
  if (process.platform !== "darwin") return;
  const osascript = (script: string) =>
    execFileSync("osascript", ["-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    const front = osascript(
      'tell application "System Events" to get name of first process whose frontmost is true',
    );
    const pid = execFileSync("pgrep", ["-f", `user-data-dir=${profileDir}`], { encoding: "utf8" })
      .split("\n")
      .find(Boolean);
    if (pid)
      osascript(
        `tell application "System Events" to set visible of (first process whose unix id is ${pid}) to false`,
      );
    if (front)
      osascript(
        `tell application "System Events" to set frontmost of process "${front.replace(/"/g, "")}" to true`,
      );
  } catch {
    // no Accessibility permission, or nothing frontmost: the window shows, nothing else changes
  }
}

/** Launch flags that keep a site from telling the browser apart from a person's. */
const LOCAL_ARGS = ["--disable-blink-features=AutomationControlled"];

/** The user agent a headed Chrome of the installed version would send; learned from the first headless launch. */
let headedUserAgent: string | null = null;

async function launchLocal(profileDir: string, opts: BrowserOptions): Promise<BrowserContext> {
  const headless = opts.headless ?? true;
  const base = {
    headless,
    viewport: { width: 1280, height: 900 },
    args: LOCAL_ARGS,
    ignoreDefaultArgs: ["--enable-automation"],
    ...(headless && headedUserAgent ? { userAgent: headedUserAgent } : {}),
  };
  const launch = async (o: typeof base) => {
    if (opts.channel !== "chromium") {
      try {
        return await chromium.launchPersistentContext(profileDir, { ...o, channel: "chrome" });
      } catch (err) {
        if (!/executable doesn't exist|chrome/i.test(err instanceof Error ? err.message : ""))
          throw err;
      }
    }
    return chromium.launchPersistentContext(profileDir, o);
  };
  const context = await launch(base);
  if (!headless || headedUserAgent) return context;
  // Headless Chrome says "HeadlessChrome/153…" and sites like YouTube Studio refuse it as an
  // unsupported browser. The version is only known once launched: learn it, relaunch as the headed one.
  const ua = await (context.pages()[0] ?? (await context.newPage())).evaluate(
    () => navigator.userAgent,
  );
  if (!ua.includes("HeadlessChrome")) return context;
  headedUserAgent = ua.replace("HeadlessChrome", "Chrome");
  await context.close();
  return launch({ ...base, userAgent: headedUserAgent });
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
/**
 * The page's visible text, cut in the page: only `limit` characters cross
 * the CDP socket, not a whole document read for its first lines. Empty
 * when the page is gone or mid-navigation.
 */
export async function bodyText(page: Page, limit: number): Promise<string> {
  return page
    .evaluate((n) => (document.body ? document.body.innerText : "").slice(0, n), limit)
    .catch(() => "");
}
// The in-page functions above and below run in the browser; this module compiles without the DOM lib.
declare const document: {
  body: { innerText: string } | null;
  documentElement: { outerHTML: string } | null;
};

/** The page's HTML, cut in the page the same way. */
export async function pageHtml(page: Page, limit: number): Promise<string> {
  return page
    .evaluate(
      (n) => (document.documentElement ? document.documentElement.outerHTML : "").slice(0, n),
      limit,
    )
    .catch(() => "");
}

export interface Wall {
  /** `login` and `challenge` can be solved with credentials and codes; `captcha` still needs a person (or Browserbase). */
  kind: "login" | "challenge" | "captcha";
  detail: string;
}

export async function looksLikeWall(page: Page): Promise<Wall | null> {
  const url = page.url();
  // A sign-in path segment, not a substring: myaccount's /signinoptions/ is a settings page.
  if (/accounts\.google\.com\/|signin\.aws\.amazon\.com\/|\/(login|sign-?in)(\/|\?|#|$)/i.test(url))
    return { kind: "login", detail: `login page: ${url}` };
  return wallOf(url, await bodyText(page, 4000));
}

/** The wall a URL and page text show, if any; `looksLikeWall` over a page, this over what a flow already read. */
export function wallOf(url: string, text: string): Wall | null {
  if (/accounts\.google\.com\/|signin\.aws\.amazon\.com\/|\/(login|sign-?in)(\/|\?|#|$)/i.test(url))
    return { kind: "login", detail: `login page: ${url}` };
  // "protected by reCAPTCHA" is the legal footer on every sign-up form, not a wall.
  if (
    /verify you are human|(?<!protected by re)captcha|i'm not a robot|unusual traffic|performing security verification|verifies you are not a bot/i.test(
      text,
    )
  )
    return { kind: "captcha", detail: "captcha" };
  if (/verify your phone|enter the code|2-step verification/i.test(text))
    return { kind: "challenge", detail: "verification challenge" };
  // A login form rendered under whatever URL was asked for (platform.claude.com does this).
  if (
    /\b(continue|sign ?in|log ?in|sign ?up) with (google|email|sso|github|microsoft|apple)\b/i.test(
      text,
    )
  )
    return { kind: "login", detail: `login form on ${url}` };
  return null;
}
