/**
 * One browser session per flow run. Local: a persistent Chromium profile
 * per site, so a login done once by hand (`autobrowse record <site>`) is
 * still there next run. Browserbase: a persistent context on their side,
 * same idea. Either way the session is opened for one flow and closed
 * after it; `flow.ts` decides when and holds the per-site lock.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { type HttpClient, safeUrls } from "../clients/http.js";
import { expandHome } from "../google-auth.js";
import { assertProfileFree } from "./browsers.js";
import type { Egress, Exit } from "./egress.js";
import { geometry, type Identity, learnIdentity, wearIdentity } from "./identity.js";
import { keepSessionCookies, keptDomains } from "./keep-session.js";
import type { Hints } from "./locate.js";
import { notReachable, type OwnBrowser, ownEndpoint, runsInOwn } from "./own.js";
import { reapOrphans, reapTempDirs } from "./reap.js";
import { type PasskeyRecord, type Passkeys, virtualAuthenticator } from "./webauthn.js";

/**
 * Patchright: Playwright with the CDP tells (Runtime.enable, console hooks)
 * patched out, so Cloudflare Turnstile and bot walls see a plain Chrome.
 * Same API and browser builds. Loads on the first browser, not at process
 * start (~2 s of a CLI's boot).
 */
const chromium = async () =>
  (await import("patchright")).chromium as unknown as typeof import("playwright").chromium;

/** A page needs a person: login, captcha, consent, or a layout nobody planned for. */
export class NeedsHuman extends Error {
  /** Set by the runner, not the flow: where the screenshot and trace went. */
  artifacts: Artifacts = {};
  constructor(reason: string) {
    super(safeUrls(reason));
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
  /** A watched run's steps (`WATCH_FLOWS`): steps.jsonl, a masked shot and aria per step. */
  steps?: string;
}

/** What a flow left behind when it stopped: enough for an agent to pick up where it fell. */
export interface FailureRecord {
  site: string;
  flow: string;
  url: string;
  /** The goal of the last act the flow attempted, when there was one. */
  goal: string | null;
  /** What the last act or read looked for: pins the one op that broke. */
  hints?: Hints;
  /** Acts and reads the run made before that one: tells two "click Next" apart. */
  actsBefore?: number;
  error: string;
  kind: "failed" | "human" | "interrupted";
  at: string;
  screenshot?: string;
  aria?: string;
  /** Every step up to the failure, when the run was watched. */
  steps?: string;
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
  /** Flows watched step by step (`WATCH_FLOWS`, see `browser/watch`); the runner's own `watch` wins. */
  watchFlows?: string;
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
  /** The profile directory a name opens: the stored account it names (`x@wren_automation` → `x@wren`). */
  profileName?: (name: string) => Promise<string>;
  /** Where a site's sign-in provider holds its session (a flow's `profile: "provider"`); null = its own. */
  providerProfile?: (site: string) => Promise<string | null>;
  /** The person's own browser, for the sites they opted in (`browser/own`). */
  own?: OwnBrowser | null;
  /** Where each local profile leaves from (`browser/egress`); none = the machine's own line. */
  egress?: Egress;
  /**
   * The time zone a local browser says (`America/New_York`): the one where its
   * IP is, or a site sees a Virginia IP on UTC. A profile behind an exit says
   * the exit's (`EGRESS_<NAME>_TZ`); the rest this; the machine's own when unset.
   */
  timezone?: string;
}

export interface Session {
  context: BrowserContext;
  page: Page;
  /**
   * The person's own browser: the context holds their tabs too, so nothing
   * context-wide (trace, routes, init scripts) is done to it.
   */
  shared?: boolean;
  /** The virtual authenticator: export after an enrollment. */
  passkeys: Passkeys;
  /** A new IP from the profile's exit, when it rotates (`browser/egress`); false otherwise. */
  newIp?: () => Promise<boolean>;
  close(): Promise<void>;
}

export async function openSession(site: string, opts: BrowserOptions): Promise<Session> {
  if (runsInOwn(opts.own, site)) return openOwn(opts.own);
  const asked = opts.profile ?? site;
  const profile = (await opts.profileName?.(asked)) ?? asked;
  let context: BrowserContext;
  let browser: Browser | null = null;
  if (opts.tier === "browserbase") {
    if (!opts.browserbase)
      throw new Error("BROWSER=browserbase needs BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID");
    const contextId = await browserbaseContext(profile, opts.browserbase);
    const session = await browserbaseSession(opts.browserbase, contextId);
    browser = await (await chromium()).connectOverCDP(session.connectUrl);
    context = browser.contexts()[0] ?? (await browser.newContext());
  } else if (opts.tier === "cdp") {
    if (!opts.cdpUrl) throw new Error("BROWSER=cdp needs BROWSER_CDP_URL");
    // The app's own context and pages: nothing is launched, nothing closed on our way out.
    browser = await (await chromium()).connectOverCDP(opts.cdpUrl);
    context = browser.contexts()[0] ?? (await browser.newContext());
  } else {
    const profileDir = join(expandHome(opts.profilesDir), profile);
    // A browser left by a dead owner would hold this profile; stop those first.
    const reaped = await reapOrphans(expandHome(opts.profilesDir));
    await assertProfileFree(
      profileDir,
      profile,
      reaped.map((o) => o.pid),
    );
    void reapTempDirs(); // files a crashed upload left, in the background
    context = await launchLocal(profileDir, opts, opts.egress?.exitFor(profile) ?? null);
    if (opts.headless === false) keepOutOfTheWay();
    // `navigator.webdriver` is already false (LOCAL_ARGS). No init-script shim: an own
    // `webdriver` property on navigator, reading undefined, is itself a tell.
  }
  const page = context.pages()[0] ?? (await context.newPage());
  const passkeys = virtualAuthenticator(context, await opts.passkeys?.(site).catch(() => []));
  const local = opts.tier !== "browserbase" && opts.tier !== "cdp";
  return {
    context,
    page,
    passkeys,
    ...(local && opts.egress ? { newIp: () => (opts.egress as Egress).newIp(profile) } : {}),
    async close() {
      // An attached app keeps its windows; only what we launched or rented closes.
      if (opts.tier === "cdp") {
        await browser?.close().catch(() => undefined);
        return;
      }
      // By site: the profile can be another's (William's LinkedIn signs in through the `google` profile).
      const keep = local ? keptDomains(site) : null;
      if (keep) await keepSessionCookies(context, keep).catch(() => 0);
      await context.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    },
  };
}

/** A tab of our own in the person's browser; closing it leaves the browser and their tabs. */
async function openOwn(own: OwnBrowser): Promise<Session> {
  const url = await ownEndpoint(own);
  // The browser asks the person to allow the connection: give them time to.
  // Plain Playwright: their browser needs no stealth patches, and patchright's
  // request interception on every target dies on the browser's own internal pages.
  const browser = await (await import("playwright")).chromium
    .connectOverCDP(url, { timeout: 120_000 })
    .catch((err: unknown) => {
      throw new Error(
        `${notReachable(own)} (${err instanceof Error ? err.message.split("\n")[0] : err})`,
      );
    });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  return {
    context,
    page,
    shared: true,
    // Their passkeys stay theirs: no virtual authenticator in their browser.
    passkeys: { export: async () => [] },
    async close() {
      await page.close().catch(() => undefined);
      await browser.close().catch(() => undefined); // disconnects; the browser stays open
    },
  };
}

/**
 * A headed Chrome on a laptop someone is using: give focus back to the app
 * that had it; the window stays, behind. Never hidden: a hidden window
 * stops Chrome routing clicks into a cross-site frame inside a frame (the
 * parent gets them), so a captcha checkbox never ticks. Best effort; only
 * macOS has the tools.
 */
function keepOutOfTheWay(): void {
  if (process.platform !== "darwin") return;
  try {
    const front = execFileSync(
      "osascript",
      [
        "-e",
        'tell application "System Events" to get name of first process whose frontmost is true',
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (front)
      execFileSync(
        "osascript",
        [
          "-e",
          `tell application "System Events" to set frontmost of process "${front.replace(/"/g, "")}" to true`,
        ],
        { stdio: "ignore" },
      );
  } catch {
    // no Accessibility permission, or nothing frontmost: Chrome keeps the focus
  }
}

/** Launch flags that keep a site from telling the browser apart from a person's. */
/**
 * A Linux box has no GPU, and headed Chrome there has no WebGL at all (it dropped the
 * software fallback): a rarer tell than the software renderer this turns back on.
 */
const NO_GPU_ARGS = process.platform === "linux" ? ["--enable-unsafe-swiftshader"] : [];
const LOCAL_ARGS = ["--disable-blink-features=AutomationControlled", ...NO_GPU_ARGS];

/**
 * Behind a proxy, WebRTC would still ask STUN over UDP from the machine's
 * own address and show the page the IP the proxy hides; only proxied UDP
 * (none, for an HTTP proxy) is allowed.
 */
const PROXIED_ARGS = ["--webrtc-ip-handling-policy=disable_non_proxied_udp"];

/** The headed identity of this host's Chrome, learned on the first headless launch. */
let headedIdentity: Identity | null = null;

async function launchLocal(
  profileDir: string,
  opts: BrowserOptions,
  exit: Exit | null,
): Promise<BrowserContext> {
  const proxy = exit?.proxy ?? null;
  const headless = opts.headless ?? true;
  const { args: sizeArgs, ...size } = geometry(headless);
  // Headless says the headed identity (identity.ts). Not through Playwright's
  // `userAgent`: that rebuilds the client hints from the UA string and sends
  // `Sec-CH-UA-Arch: "x86"` and platform version "10_15_7" from an arm Mac on 26.x.
  const uaArgs = (ua: string | null) => (headless && ua ? [`--user-agent=${ua}`] : []);
  // Chrome takes its zone from TZ: Date, Intl and workers agree, where a CDP override covers pages only.
  const tz = exit?.timezone ?? opts.timezone;
  const base = (ua: string | null) => ({
    headless,
    ...size,
    args: [...LOCAL_ARGS, ...(proxy ? PROXIED_ARGS : []), ...sizeArgs, ...uaArgs(ua)],
    ignoreDefaultArgs: ["--enable-automation"],
    ...(proxy ? { proxy } : {}),
    ...(tz ? { env: { ...process.env, TZ: tz } } : {}),
  });
  const launch = async (o: ReturnType<typeof base>) => {
    if (opts.channel !== "chromium") {
      try {
        return await (await chromium()).launchPersistentContext(profileDir, {
          ...o,
          channel: "chrome",
        });
      } catch (err) {
        if (!/executable doesn't exist|chrome/i.test(err instanceof Error ? err.message : ""))
          throw err;
      }
    }
    return (await chromium()).launchPersistentContext(profileDir, o);
  };
  const context = await launch(base(headedIdentity?.userAgent ?? null));
  if (!headless) return context;
  if (headedIdentity) {
    wearIdentity(context, headedIdentity);
    return context;
  }
  // Headless Chrome says "HeadlessChrome/153…" and sites like YouTube Studio refuse it as an
  // unsupported browser. The version is only known once launched: learn it, relaunch as the headed one.
  const learned = await learnIdentity(context.pages()[0] ?? (await context.newPage()));
  if (!learned.headless) return context;
  headedIdentity = learned.identity;
  await context.close();
  const relaunched = await launch(base(headedIdentity.userAgent));
  wearIdentity(relaunched, headedIdentity);
  return relaunched;
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
  // LinkedIn signed out: every member page goes to /authwall ("Join LinkedIn", a Sign in link).
  if (/^https:\/\/www\.linkedin\.com\/authwall(\/|\?|$)/i.test(url))
    return { kind: "login", detail: `signed out: ${url}` };
  // Google Account signed out: myaccount sends every page to its /intro/ twin with a "Sign in" button.
  if (/^https:\/\/myaccount\.google\.com\/intro(\/|\?|$)/i.test(url))
    return { kind: "login", detail: `signed out: ${url}` };
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
