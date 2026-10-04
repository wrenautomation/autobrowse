/**
 * Where each local browser leaves from (designs/2026-10-04-egress.md).
 * `EGRESS_SITES=web:mobile,linkedin@research:isp` maps a site (`x`: every x
 * profile) or one profile to a named exit; anything unlisted, or listed as
 * `desk`, goes out on the machine's own line. An exit is
 * `EGRESS_<NAME>=scheme://user:pass@host:port`, with optional
 * `EGRESS_<NAME>_TZ` (its city), `EGRESS_<NAME>_ROTATE` (a URL that gives it
 * a new IP) and `EGRESS_<NAME>_GAP` (seconds between rotations, default 120).
 * A rotating exit never serves a site we sign in to: a signed-in session
 * that hops IPs is its own flag. URLs hold passwords and tokens; nothing
 * here prints them.
 */

export interface BrowserProxy {
  server: string;
  username?: string;
  password?: string;
}

export interface Exit {
  name: string;
  proxy: BrowserProxy;
  /** The zone a browser behind it says: the exit's city. */
  timezone?: string;
  rotates: boolean;
}

export interface Egress {
  /** The exit for a profile, or null: it goes out directly. */
  exitFor(profile: string): Exit | null;
  /**
   * A new IP for the profile's exit: true once the rotate URL answered and
   * the line settled. False when the exit does not rotate, rotated less than
   * its gap ago, or the URL failed.
   */
  newIp(profile: string): Promise<boolean>;
  /** One line per mapping, e.g. `web → mobile (rotates)`: no URLs. */
  describe(): string[];
}

export const DESK = "desk";
const DEFAULT_GAP_S = 120;
/** A carrier hands out the new address within seconds; pages before that fail. */
const SETTLE_MS = 10_000;
const ROTATE_TIMEOUT_MS = 30_000;

export function proxyOf(url: string, label: string): BrowserProxy {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`${label} is not a URL (scheme://user:pass@host:port)`);
  }
  if (!/^(https?|socks5):$/.test(u.protocol) || !u.hostname)
    throw new Error(`${label} needs http, https or socks5 and a host`);
  if (u.protocol === "socks5:" && (u.username || u.password))
    throw new Error(`${label}: Chrome takes no login on a socks5 proxy; use http`);
  const p: BrowserProxy = { server: `${u.protocol}//${u.host}` };
  if (u.username) p.username = decodeURIComponent(u.username);
  if (u.password) p.password = decodeURIComponent(u.password);
  return p;
}

export interface EgressDeps {
  /** True for a site we sign in to (`auth/sites`): a rotating exit may not serve it. */
  signsIn: (site: string) => boolean;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const NO_EGRESS: Egress = {
  exitFor: () => null,
  newIp: async () => false,
  describe: () => [],
};

export function egressOf(env: (name: string) => string | undefined, deps: EgressDeps): Egress {
  const map = new Map<string, string>();
  for (const entry of (env("EGRESS_SITES") ?? "").split(",")) {
    const e = entry.trim().toLowerCase();
    if (!e) continue;
    const [who, exit, ...rest] = e.split(":").map((s) => s.trim());
    if (!who || !exit || rest.length || !/^[a-z0-9]+$/.test(exit))
      throw new Error(`EGRESS_SITES: "${e}" is not <site or profile>:<exit>`);
    map.set(who, exit);
  }
  if (!map.size) return NO_EGRESS;

  const exits = new Map<string, Exit & { rotateUrl?: string; gapMs: number }>();
  for (const name of new Set(map.values())) {
    if (name === DESK) continue;
    const key = `EGRESS_${name.toUpperCase()}`;
    const url = env(key)?.trim();
    if (!url) throw new Error(`EGRESS_SITES names exit ${name}, but ${key} is unset`);
    const tz = env(`${key}_TZ`)?.trim();
    if (tz) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
      } catch {
        throw new Error(`${key}_TZ: not an IANA time zone`);
      }
    }
    const rotateUrl = env(`${key}_ROTATE`)?.trim() || undefined;
    if (rotateUrl && !/^https?:\/\//.test(rotateUrl))
      throw new Error(`${key}_ROTATE needs an http(s) URL`);
    const gap = Number(env(`${key}_GAP`) ?? DEFAULT_GAP_S);
    if (!Number.isFinite(gap) || gap < 0) throw new Error(`${key}_GAP: seconds, 0 or more`);
    exits.set(name, {
      name,
      proxy: proxyOf(url, key),
      ...(tz ? { timezone: tz } : {}),
      rotates: Boolean(rotateUrl),
      ...(rotateUrl ? { rotateUrl } : {}),
      gapMs: gap * 1000,
    });
  }

  for (const [who, name] of map) {
    if (!exits.get(name)?.rotates) continue;
    const base = who.split("@")[0] ?? "";
    if (who === "*" || deps.signsIn(base))
      throw new Error(
        `EGRESS_SITES: ${who} signs in, so it cannot use ${name}, which rotates its IP`,
      );
  }

  const exitName = (profile: string): string | undefined => {
    const name = profile.toLowerCase();
    return map.get(name) ?? map.get(name.split("@")[0] ?? "") ?? map.get("*");
  };
  const exitFor = (profile: string): Exit | null => {
    const e = exits.get(exitName(profile) ?? DESK);
    if (!e) return null;
    return {
      name: e.name,
      proxy: e.proxy,
      rotates: e.rotates,
      ...(e.timezone ? { timezone: e.timezone } : {}),
    };
  };

  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const last = new Map<string, number>();
  const busy = new Map<string, Promise<boolean>>();

  async function rotate(e: Exit & { rotateUrl?: string; gapMs: number }): Promise<boolean> {
    const at = last.get(e.name);
    if (!e.rotateUrl || (at !== undefined && now() - at < e.gapMs)) return false;
    last.set(e.name, now());
    try {
      const res = await doFetch(e.rotateUrl, { signal: AbortSignal.timeout(ROTATE_TIMEOUT_MS) });
      if (!res.ok) return false;
    } catch {
      return false;
    }
    await sleep(SETTLE_MS);
    return true;
  }

  return {
    exitFor,
    async newIp(profile) {
      const e = exits.get(exitName(profile) ?? DESK);
      if (!e?.rotates) return false;
      // Two profiles on one exit share its IP: one rotation answers both.
      const running = busy.get(e.name);
      if (running) return running;
      const p = rotate(e).finally(() => busy.delete(e.name));
      busy.set(e.name, p);
      return p;
    },
    describe: () =>
      [...map].map(([who, name]) =>
        name === DESK
          ? `${who} → desk`
          : `${who} → ${name}${exits.get(name)?.rotates ? " (rotates)" : ""}`,
      ),
  };
}
