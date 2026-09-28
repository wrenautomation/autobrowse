/**
 * The person's own browser: the one they use every day, already signed in,
 * with the history a site trusts. Some sites refuse a fresh profile however
 * clean (GitHub turns away "Continue with Google" from one); they take the
 * same click from here. Opt-in per site (`OWN_BROWSER_SITES`).
 *
 * Attached, not launched: the browser keeps running and nothing restarts.
 * The person turns on "Allow remote debugging" once at
 * `<scheme>://inspect/#remote-debugging`; the browser then writes its
 * endpoint to `DevToolsActivePort` in its data dir, and asks them to allow
 * each connection. autobrowse works in a new tab of its own and closes only
 * that tab: no trace, no passkey stand-in, nothing on their other tabs.
 *
 * Chromium browsers only. Safari has no remote debugging: its WebDriver
 * sessions are fresh (none of the person's logins), and Apple Events only
 * run page JS, whose clicks a sign-in page can tell from a person's
 * (`isTrusted`). `OWN_BROWSER=safari` says so instead of failing oddly
 * (designs/2026-09-27-own-browser.md).
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OwnBrowser {
  /** What the person calls it, for messages. */
  name: string;
  /** Its data dir: where `DevToolsActivePort` appears once debugging is allowed. */
  dataDir: string;
  /** Where the switch is. */
  inspectUrl: string;
  /** Sites (base names: `github` covers `github@wren`) that run here. */
  sites: readonly string[];
  /** Why this browser can't be attached, when it never can (Safari). */
  never?: string;
}

const SAFARI =
  "Safari can't be driven with your logins: it has no remote debugging, and its automation windows start signed out. Use chrome (or another Chromium browser) for OWN_BROWSER";

const SUPPORT = join(homedir(), "Library", "Application Support");

/** Browsers by the name `OWN_BROWSER` takes. Any other value is the data dir itself. */
const KNOWN: Record<string, { name: string; dir: string; scheme: string }> = {
  "opera-gx": {
    name: "Opera GX",
    dir: join(SUPPORT, "com.operasoftware.OperaGX"),
    scheme: "opera",
  },
  opera: { name: "Opera", dir: join(SUPPORT, "com.operasoftware.Opera"), scheme: "opera" },
  chrome: { name: "Chrome", dir: join(SUPPORT, "Google", "Chrome"), scheme: "chrome" },
  brave: { name: "Brave", dir: join(SUPPORT, "BraveSoftware", "Brave-Browser"), scheme: "brave" },
  edge: { name: "Edge", dir: join(SUPPORT, "Microsoft Edge"), scheme: "edge" },
};

export function ownBrowserOf(
  which: string | undefined,
  sites: string | undefined,
): OwnBrowser | null {
  const list = (sites ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) return null;
  if (which === "safari")
    return {
      name: "Safari",
      dataDir: "",
      inspectUrl: "",
      sites: list,
      never: SAFARI,
    };
  // Chrome unless told otherwise: the browser a person's logins usually live in.
  const known = KNOWN[which ?? "chrome"];
  return known
    ? {
        name: known.name,
        dataDir: known.dir,
        inspectUrl: `${known.scheme}://inspect/#remote-debugging`,
        sites: list,
      }
    : {
        name: which ?? "chrome",
        dataDir: which ?? "chrome",
        inspectUrl: "chrome://inspect/#remote-debugging",
        sites: list,
      };
}

/** Whether this site's work runs in the person's own browser. */
export const runsInOwn = (own: OwnBrowser | null | undefined, site: string): own is OwnBrowser =>
  !!own && own.sites.includes(site.split("@")[0] ?? site);

/** The browser's CDP endpoint, from the file it writes while debugging is allowed. */
export async function ownEndpoint(own: OwnBrowser): Promise<string> {
  if (own.never) throw new Error(own.never);
  const raw = await readFile(join(own.dataDir, "DevToolsActivePort"), "utf8").catch(() => null);
  const [port, path] = (raw ?? "").split("\n").map((l) => l.trim());
  if (!port || !/^\d+$/.test(port) || !path?.startsWith("/devtools/browser/"))
    throw new Error(notReachable(own));
  return `ws://127.0.0.1:${port}${path}`;
}

export const notReachable = (own: OwnBrowser) =>
  `${own.name} is not reachable: open it, go to ${own.inspectUrl}, turn on "Allow remote debugging", then allow the connection when it asks`;
