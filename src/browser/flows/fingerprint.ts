/**
 * How a browser looks to X, LinkedIn and Cloudflare: the IP it goes out
 * from (whose network, which time zone), and what its page shows (user
 * agent, WebGL, codecs, WebRTC). `tells` lists what gives it away, so a
 * change to the box, the proxy or the launch flags is measured, not hoped.
 * Runs in any profile (`browser/flow` with `profile`, `autobrowse
 * fingerprint <profile>`), through that profile's proxy. IPs leave only
 * masked: the full ones are the person's home or the proxy's login.
 */
import { defineFlow } from "../flow.js";

/** Whose network the IP is on and where, as ipinfo says it. */
export interface IpLook {
  ip: string;
  org: string | null;
  country: string | null;
  region: string | null;
  timezone: string | null;
}

/** What the page shows. */
export interface PageLook {
  userAgent: string;
  brands: string[];
  uaPlatform: string | null;
  platform: string;
  webdriver: boolean;
  languages: string[];
  timezone: string;
  cores: number;
  memory: number | null;
  screen: { width: number; height: number };
  window: { inner: [number, number]; outer: [number, number] };
  webgl: { vendor: string | null; renderer: string | null };
  h264: boolean;
  plugins: number;
  /** Notification.permission beside what permissions.query says: headless answers denied/prompt. */
  notifications: { permission: string; query: string | null };
  /** Public IPs WebRTC found over STUN (server-reflexive candidates). */
  webrtc: string[];
}

export interface Fingerprint {
  ip: IpLook | null;
  page: PageLook;
  /** What gives the browser away; empty when nothing does. */
  tells: string[];
}

/** Clouds and hosts a site scores as "not a person": the org ipinfo names. */
const DATACENTER =
  /amazon|aws|google cloud|google llc|microsoft|azure|digitalocean|hetzner|ovh|linode|akamai|oracle|vultr|choopa|m247|datacamp|contabo|scaleway|leaseweb|racknerd|colocrossing|cloudflare/i;

/** WebGL drawn in software: a machine with no GPU (a VM, a container). */
const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|mesa offscreen|software/i;

/** `203.0.113.7` → `203.0.x.x`; v6 keeps its first two groups. */
export function maskIp(ip: string): string {
  if (ip.includes(":")) return `${ip.split(":").slice(0, 2).join(":")}:…`;
  const [a, b] = ip.split(".");
  return `${a}.${b}.x.x`;
}

const platformOfUa = (ua: string): string | null =>
  /Windows/.test(ua)
    ? "Windows"
    : /Mac OS X|Macintosh/.test(ua)
      ? "macOS"
      : /Android/.test(ua)
        ? "Android"
        : /Linux|X11/.test(ua)
          ? "Linux"
          : null;

/** What gives this browser away, in words; empty when nothing does. Full IPs in, masked out. */
export function tellsOf(ip: IpLook | null, p: PageLook): string[] {
  const t: string[] = [];
  if (p.webdriver) t.push("navigator.webdriver is true");
  if (/Headless/i.test(p.userAgent) || p.brands.some((b) => /Headless/i.test(b)))
    t.push("says HeadlessChrome");
  // Chrome has sent `Chrome/154.0.0.0` since the UA reduction; a full build number is a hand-set UA or a test build.
  if (/Chrome\/\d+\.\d+\.[1-9]/.test(p.userAgent))
    t.push("full Chrome version in the user agent (not reduced)");
  const uaPlatform = platformOfUa(p.userAgent);
  if (uaPlatform && p.uaPlatform && uaPlatform !== p.uaPlatform)
    t.push(`user agent says ${uaPlatform}, client hints say ${p.uaPlatform}`);
  if (p.webgl.renderer && SOFTWARE_GL.test(p.webgl.renderer))
    t.push(`WebGL in software, no GPU (${p.webgl.renderer})`);
  if (!p.webgl.renderer) t.push("no WebGL");
  if (!p.h264) t.push("no H.264: Chromium, not Google Chrome");
  if (!p.plugins) t.push("no plugins (a headless build)");
  if (!p.languages.length) t.push("no languages");
  if (p.notifications.permission === "denied" && p.notifications.query === "prompt")
    t.push("notification permission says denied while the query says prompt (headless)");
  if (p.window.outer[1] > 0 && p.window.outer[1] <= p.window.inner[1])
    t.push("no browser frame around the page (headless window)");
  if (ip?.org && DATACENTER.test(ip.org)) t.push(`datacenter IP (${ip.org})`);
  if (ip?.timezone && ip.timezone !== p.timezone)
    t.push(`time zone ${p.timezone}, but the IP is in ${ip.timezone}`);
  const leaks = ip ? p.webrtc.filter((w) => w !== ip.ip) : [];
  if (leaks.length) t.push(`WebRTC shows ${leaks.map(maskIp).join(", ")}, not the IP pages see`);
  return t;
}

/** Runs in the page; a string, so the project compiles without the DOM lib. */
const LOOK = `(async () => {
  const n = navigator;
  const gl = (() => {
    try {
      const c = document.createElement("canvas").getContext("webgl");
      const x = c && c.getExtension("WEBGL_debug_renderer_info");
      return x ? { vendor: c.getParameter(x.UNMASKED_VENDOR_WEBGL), renderer: c.getParameter(x.UNMASKED_RENDERER_WEBGL) }
        : { vendor: null, renderer: null };
    } catch { return { vendor: null, renderer: null }; }
  })();
  const query = await n.permissions.query({ name: "notifications" }).then((s) => s.state, () => null);
  const webrtc = await new Promise((done) => {
    const found = new Set();
    let pc;
    try { pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }); }
    catch { return done([]); }
    const end = () => { try { pc.close(); } catch {} done([...found]); };
    pc.onicecandidate = (e) => {
      if (!e.candidate) return end();
      const m = / (\\S+) \\d+ typ srflx/.exec(e.candidate.candidate);
      if (m) found.add(m[1]);
    };
    pc.createDataChannel("x");
    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(end);
    setTimeout(end, 4000);
  });
  return {
    userAgent: n.userAgent,
    brands: (n.userAgentData?.brands ?? []).map((b) => b.brand),
    uaPlatform: n.userAgentData?.platform || null,
    platform: n.platform,
    webdriver: n.webdriver === true,
    languages: [...(n.languages ?? [])],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cores: n.hardwareConcurrency,
    memory: n.deviceMemory ?? null,
    screen: { width: screen.width, height: screen.height },
    window: { inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight] },
    webgl: gl,
    h264: document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E"') !== "",
    plugins: n.plugins.length,
    notifications: { permission: typeof Notification === "undefined" ? "none" : Notification.permission, query },
    webrtc,
  };
})()`;

/** Where the IP is looked up: a JSON page, fetched as a page so it goes out through the proxy. */
export const IP_URL = "https://ipinfo.io/json";

export function ipOf(raw: unknown): IpLook | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r.ip !== "string") return null;
  const s = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : null);
  return {
    ip: r.ip,
    org: s("org"),
    country: s("country"),
    region: s("region"),
    timezone: s("timezone"),
  };
}

export const fingerprint = defineFlow<{ url?: string }, Fingerprint>({
  site: "fingerprint",
  name: "check",
  async run(fp, input) {
    await fp.open(input.url ?? IP_URL);
    const ip = ipOf(
      await fp.page.evaluate(
        "(() => { try { return JSON.parse(document.body.innerText); } catch { return null; } })()",
      ),
    );
    const page = (await fp.page.evaluate(LOOK)) as PageLook;
    return {
      ip: ip && { ...ip, ip: maskIp(ip.ip) },
      page: { ...page, webrtc: page.webrtc.map(maskIp) },
      tells: tellsOf(ip, page),
    };
  },
});
