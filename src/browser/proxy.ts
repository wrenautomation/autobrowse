/**
 * Which sites' browsers go out through a proxy. X and LinkedIn score the
 * IP a session comes from: a home connection passes, a datacenter one (the
 * box on EC2) is the scraper's tell. `BROWSER_PROXY` (a static ISP or
 * residential proxy, `http://user:pass@host:port`) serves the sites in
 * `BROWSER_PROXY_SITES`, by the base site of the profile (`x@wren` → `x`).
 * Keep one proxy per account: a signed-in session that hops IPs is its own
 * flag. The URL holds a password; nothing here prints it.
 */

export interface BrowserProxy {
  server: string;
  username?: string;
  password?: string;
}

/** The proxy for a profile, or null: a site not listed goes out directly. */
export type ProxyFor = (profile: string) => BrowserProxy | null;

export function proxyOf(url: string): BrowserProxy {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("BROWSER_PROXY is not a URL (scheme://user:pass@host:port)");
  }
  if (!/^(https?|socks5):$/.test(u.protocol) || !u.hostname)
    throw new Error("BROWSER_PROXY needs http, https or socks5 and a host");
  if (u.protocol === "socks5:" && u.username)
    throw new Error("BROWSER_PROXY: Chrome takes no login on a socks5 proxy; use http");
  const p: BrowserProxy = { server: `${u.protocol}//${u.host}` };
  if (u.username) p.username = decodeURIComponent(u.username);
  if (u.password) p.password = decodeURIComponent(u.password);
  return p;
}

export function proxyFor(url: string | undefined, sites: string | undefined): ProxyFor {
  const listed = new Set(
    (sites ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  if (!url || !listed.size) return () => null;
  const proxy = proxyOf(url);
  return (profile) => {
    const base = profile.split("@")[0]?.toLowerCase() ?? "";
    return listed.has(base) || listed.has("*") ? proxy : null;
  };
}
