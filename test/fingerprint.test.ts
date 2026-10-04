import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/app/config.js";
import type { FlowPage } from "../src/browser/flow.js";
import {
  fingerprint,
  IP_URL,
  type IpLook,
  ipOf,
  maskIp,
  type PageLook,
  tellsOf,
} from "../src/browser/flows/fingerprint.js";
import { readPage, search, WebMiss } from "../src/reach/web.js";
import { type ApiLeg, SiteError } from "../src/sites/types.js";
import { web } from "../src/sites/web.js";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

/** A headed Google Chrome on a Mac at home: nothing gives it away. */
const person = (o: Partial<PageLook> = {}): PageLook => ({
  userAgent: CHROME_MAC,
  brands: ["Google Chrome", "Chromium", "Not.A/Brand"],
  uaPlatform: "macOS",
  platform: "MacIntel",
  webdriver: false,
  languages: ["en-US", "en"],
  timezone: "America/New_York",
  cores: 10,
  memory: 8,
  screen: { width: 1512, height: 982 },
  window: { inner: [1512, 862], outer: [1512, 945] },
  webgl: {
    vendor: "Google Inc. (Apple)",
    renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3)",
  },
  h264: true,
  plugins: 5,
  notifications: { permission: "default", query: "prompt" },
  webrtc: ["203.0.113.7"],
  ...o,
});

const home = (o: Partial<IpLook> = {}): IpLook => ({
  ip: "203.0.113.7",
  org: "AS7922 Comcast Cable Communications, LLC",
  country: "US",
  region: "Virginia",
  timezone: "America/New_York",
  ...o,
});

describe("maskIp", () => {
  it("keeps the first two parts of a v4 and v6 address", () => {
    expect(maskIp("203.0.113.7")).toBe("203.0.x.x");
    expect(maskIp("2001:db8:85a3::8a2e:370:7334")).toBe("2001:db8:…");
    expect(maskIp("::1")).toBe("::…");
    expect(maskIp("::ffff:203.0.113.7")).not.toContain("113.7");
  });

  it("never returns a v4 address with a port whole", () => {
    expect(maskIp("203.0.113.7:8080")).not.toContain("113.7");
  });

  it("an empty string does not print undefined", () => {
    expect(maskIp("")).not.toContain("undefined");
  });
});

describe("ipOf", () => {
  it("reads ipinfo's JSON; anything without a string ip is null", () => {
    expect(
      ipOf({ ip: "203.0.113.7", org: "AS1 X", country: "US", region: 5, city: "Reston" }),
    ).toEqual({ ip: "203.0.113.7", org: "AS1 X", country: "US", region: null, timezone: null });
    expect(ipOf(null)).toBeNull();
    expect(ipOf(undefined)).toBeNull();
    expect(ipOf("203.0.113.7")).toBeNull();
    expect(ipOf(42)).toBeNull();
    expect(ipOf([])).toBeNull();
    expect(ipOf({ ip: 203 })).toBeNull();
    expect(ipOf({ error: { title: "Wrong ip" } })).toBeNull();
  });
});

describe("tellsOf", () => {
  it("a person's browser at home has no tells", () => {
    expect(tellsOf(home(), person())).toEqual([]);
  });

  it("a stock headless Chromium on a VM shows every tell", () => {
    const t = tellsOf(
      home({ org: "AS14618 Amazon.com, Inc.", timezone: "America/New_York" }),
      person({
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.8037.57 Safari/537.36",
        brands: ["HeadlessChrome", "Chromium"],
        uaPlatform: "Linux",
        webdriver: true,
        languages: [],
        timezone: "UTC",
        window: { inner: [800, 600], outer: [800, 600] },
        webgl: {
          vendor: "Google Inc. (Google)",
          renderer:
            "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)",
        },
        h264: false,
        plugins: 0,
        notifications: { permission: "denied", query: "prompt" },
        webrtc: ["198.51.100.9"],
      }),
    );
    expect(t).toEqual([
      "navigator.webdriver is true",
      "says HeadlessChrome",
      "full Chrome version in the user agent (not reduced)",
      expect.stringMatching(/^WebGL in software, no GPU \(ANGLE/),
      "no H.264: Chromium, not Google Chrome",
      "no plugins (a headless build)",
      "no languages",
      "notification permission says denied while the query says prompt (headless)",
      "no browser frame around the page (headless window)",
      "datacenter IP (AS14618 Amazon.com, Inc.)",
      "time zone UTC, but the IP is in America/New_York",
      "WebRTC shows 198.51.x.x, not the IP pages see",
    ]);
  });

  it("the reduced Chrome version passes; a full build number is a tell", () => {
    expect(tellsOf(null, person())).toEqual([]);
    const full = CHROME_MAC.replace("154.0.0.0", "154.0.8037.57");
    expect(tellsOf(null, person({ userAgent: full }))).toEqual([
      "full Chrome version in the user agent (not reduced)",
    ]);
  });

  it("Edge and Opera say the reduced Chrome too, and pass", () => {
    const edge = `${CHROME_MAC} Edg/154.0.0.0`;
    const opera = `${CHROME_MAC} OPR/139.0.0.0`;
    expect(tellsOf(null, person({ userAgent: edge, brands: ["Microsoft Edge"] }))).toEqual([]);
    expect(tellsOf(null, person({ userAgent: opera, brands: ["Opera"] }))).toEqual([]);
  });

  it("Firefox has no Chrome version and no client hints", () => {
    const ff =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0";
    expect(tellsOf(null, person({ userAgent: ff, brands: [], uaPlatform: null }))).toEqual([]);
  });

  it("a UA platform that disagrees with the client hints is a tell; Android is not Linux", () => {
    const win =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
    expect(tellsOf(null, person({ userAgent: win }))).toEqual([
      "user agent says Windows, client hints say macOS",
    ]);
    const android =
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";
    expect(tellsOf(null, person({ userAgent: android, uaPlatform: "Android" }))).toEqual([]);
    // No client hints (Safari, Firefox, iOS): nothing to compare.
    expect(tellsOf(null, person({ userAgent: win, uaPlatform: null }))).toEqual([]);
  });

  it("a Chromebook is not told apart from its own client hints", () => {
    const cros =
      "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
    expect(tellsOf(null, person({ userAgent: cros, uaPlatform: "Chrome OS" }))).toEqual([]);
  });

  it("no WebGL at all and a software renderer are both tells", () => {
    expect(tellsOf(null, person({ webgl: { vendor: null, renderer: null } }))).toEqual([
      "no WebGL",
    ]);
    expect(tellsOf(null, person({ webgl: { vendor: "", renderer: "" } }))).toEqual(["no WebGL"]);
    expect(
      tellsOf(
        null,
        person({ webgl: { vendor: "Mesa", renderer: "llvmpipe (LLVM 15.0.7, 256 bits)" } }),
      ),
    ).toEqual(["WebGL in software, no GPU (llvmpipe (LLVM 15.0.7, 256 bits))"]);
  });

  it("a notification quirk needs both halves; no Notification at all is not a tell", () => {
    expect(
      tellsOf(null, person({ notifications: { permission: "denied", query: "denied" } })),
    ).toEqual([]);
    expect(tellsOf(null, person({ notifications: { permission: "none", query: null } }))).toEqual(
      [],
    );
  });

  it("an outer height of 0 (no window yet) is not a frameless tell", () => {
    expect(tellsOf(null, person({ window: { inner: [0, 0], outer: [0, 0] } }))).toEqual([]);
    expect(tellsOf(null, person({ window: { inner: [800, 600], outer: [800, 601] } }))).toEqual([]);
  });

  it("names clouds and hosts as datacenters; home ISPs pass", () => {
    const dc = (org: string) =>
      tellsOf(home({ org }), person()).some((t) => t.startsWith("datacenter IP"));
    for (const org of [
      "AS14618 Amazon.com, Inc.",
      "AS16509 Amazon.com, Inc.",
      "AS15169 Google LLC",
      "AS396982 Google Cloud Platform",
      "AS8075 Microsoft Corporation",
      "AS14061 DigitalOcean, LLC",
      "AS24940 Hetzner Online GmbH",
      "AS16276 OVH SAS",
      "AS20473 The Constant Company, LLC (Choopa)",
      "AS36352 RackNerd LLC",
      "AS13335 Cloudflare, Inc.",
    ])
      expect(dc(org), org).toBe(true);
    for (const org of [
      "AS7922 Comcast Cable Communications, LLC",
      "AS701 Verizon Business",
      "AS16591 Google Fiber Inc.", // a home ISP, not Google's cloud
      "AS21928 T-Mobile USA, Inc.",
      "AS3320 Deutsche Telekom AG",
    ])
      expect(dc(org), org).toBe(false);
    expect(tellsOf(home({ org: null }), person())).toEqual([]);
  });

  it("a home ISP whose name holds 'aws' is not a datacenter", () => {
    expect(tellsOf(home({ org: "AS12345 Dawson Communications" }), person())).toEqual([]);
  });

  it("time zone: the page's against the IP's, only when ipinfo names one", () => {
    expect(tellsOf(home({ timezone: null }), person({ timezone: "UTC" }))).toEqual([]);
    expect(tellsOf(home({ timezone: "America/Chicago" }), person())).toEqual([
      "time zone America/New_York, but the IP is in America/Chicago",
    ]);
  });

  it("an alias of the same zone is not a tell", () => {
    expect(
      tellsOf(home({ timezone: "Asia/Kolkata" }), person({ timezone: "Asia/Calcutta" })),
    ).toEqual([]);
  });

  it("WebRTC: the HTTP IP itself is fine, anything else leaks, masked", () => {
    expect(tellsOf(home(), person({ webrtc: [] }))).toEqual([]);
    expect(tellsOf(home(), person({ webrtc: ["203.0.113.7", "198.51.100.9"] }))).toEqual([
      "WebRTC shows 198.51.x.x, not the IP pages see",
    ]);
    // A home v6 beside a proxy's v4 is the real address showing: a leak.
    const t = tellsOf(home(), person({ webrtc: ["2001:db8:1:2::9"] }));
    expect(t).toEqual(["WebRTC shows 2001:db8:…, not the IP pages see"]);
    // No IP looked up: nothing to compare.
    expect(tellsOf(null, person({ webrtc: ["198.51.100.9"] }))).toEqual([]);
  });

  it("never prints a full IP", () => {
    const t = tellsOf(
      home({ ip: "203.0.113.7", org: "AS14618 Amazon.com, Inc." }),
      person({ webrtc: ["198.51.100.9", "2001:db8:1:2::9"] }),
    ).join(" ");
    expect(t).not.toMatch(/113\.7|100\.9|:2::9/);
  });

  it("the same v6 address in another spelling is not a leak", () => {
    expect(
      tellsOf(home({ ip: "2001:db8::9" }), person({ webrtc: ["2001:0db8:0:0:0:0:0:9"] })),
    ).toEqual([]);
  });
});

describe("fingerprint flow", () => {
  it("opens ipinfo, masks every IP it returns, and judges on the full ones", async () => {
    const opened: string[] = [];
    let n = 0;
    const fp = {
      open: async (u: string) => void opened.push(u),
      page: {
        evaluate: async () =>
          n++ === 0
            ? { ip: "203.0.113.7", org: "AS7922 Comcast", timezone: "America/New_York" }
            : person({ webrtc: ["203.0.113.7"] }),
      },
    } as unknown as FlowPage;
    const got = await fingerprint.run(fp, {});
    expect(opened).toEqual([IP_URL]);
    expect(got.ip?.ip).toBe("203.0.x.x");
    expect(got.page.webrtc).toEqual(["203.0.x.x"]);
    // Compared before masking: its own IP is no leak.
    expect(got.tells).toEqual([]);
    expect(JSON.stringify(got)).not.toContain("113.7");
  });

  it("a page that is not JSON leaves ip null and still reads the page", async () => {
    let n = 0;
    const fp = {
      open: async () => undefined,
      page: { evaluate: async () => (n++ === 0 ? null : person({ webrtc: ["198.51.100.9"] })) },
    } as unknown as FlowPage;
    const got = await fingerprint.run(fp, { url: "https://example.test/" });
    expect(got.ip).toBeNull();
    expect(got.page.webrtc).toEqual(["198.51.x.x"]);
    expect(got.tells).toEqual([]);
  });
});

describe("browser time zones in settings", () => {
  const base = { RESTATE_INGRESS_URL: "http://127.0.0.1:8080" };
  const zone = (v: string) => loadSettings({ ...base, BROWSER_TIMEZONE: v });

  it("takes IANA zones and UTC; unset is unset", () => {
    expect(zone("America/New_York").browserTimezone).toBe("America/New_York");
    expect(zone("UTC").browserTimezone).toBe("UTC");
    expect(loadSettings(base).browserTimezone).toBeUndefined();
    expect(loadSettings({ ...base, BROWSER_TIMEZONE: "" }).browserTimezone).toBeUndefined();
  });

  it("refuses a typo, naming the key, not a guess", () => {
    expect(() => zone("America/New_Yrok")).toThrow(/BROWSER_TIMEZONE: not an IANA time zone/);
    expect(() => zone("america/new_york")).toThrow(/not an IANA/);
  });

  it("takes Asia/Kolkata, the name ipinfo gives", () => {
    expect(zone("Asia/Kolkata").browserTimezone).toBe("Asia/Kolkata");
  });
  it("takes Europe/Kyiv", () => {
    expect(zone("Europe/Kyiv").browserTimezone).toBe("Europe/Kyiv");
  });
  it("takes Etc/UTC", () => {
    expect(zone("Etc/UTC").browserTimezone).toBe("Etc/UTC");
  });
});

describe("web miss edges", () => {
  const env = (vars: Record<string, string>) => async (n: string) => vars[n];
  const failing = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
  const miss = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e as WebMiss,
    );

  it("skipped beside failed is 502: something ran and broke", async () => {
    const e = await miss(
      search(
        "q",
        { env: env({ BRAVE_API_KEY: "k" }), fetch: failing },
        { order: ["exa", "brave"] },
      ),
    );
    expect(e?.status).toBe(502);
    expect(e?.message).toMatch(/exa \(skipped: no EXA_API_KEY\); brave \(Error: HTTP 500\)/);
  });

  it("a read whose URL carries a credential and whose fetch fails is 502, the key unsaid", async () => {
    const e = await miss(
      readPage("https://x.test/?token=s3cr3t", { env: env({}), fetch: failing }),
    );
    expect(e?.status).toBe(502);
    expect(e?.message).not.toContain("s3cr3t");
  });

  it("an unknown via is 400 even after a backend failed before it", async () => {
    const e = await miss(
      search(
        "q",
        { env: env({ BRAVE_API_KEY: "k" }), fetch: failing },
        { order: ["brave", "bing"] },
      ),
    );
    expect(e).toBeInstanceOf(WebMiss);
    expect(e?.status).toBe(400);
    expect(e?.message).toMatch(/no backend bing; there are exa, brave, duckduckgo/);
  });

  it("an unknown via is 400 wherever it sits in the list", async () => {
    const ok = (async () =>
      new Response(
        JSON.stringify({ results: [{ url: "https://a.test" }] }),
      )) as unknown as typeof fetch;
    const e = await miss(
      search("q", { env: env({ EXA_API_KEY: "k" }), fetch: ok }, { order: ["exa", "bing"] }),
    );
    expect(e?.status).toBe(400);
  });

  it("an empty via list is not a 501 with nothing tried", async () => {
    const e = await miss(search("q", { env: env({}), fetch: failing }, { order: [] }));
    expect(e?.status).toBe(400);
  });

  it("through the site: 400, 501 and 502 all become SiteErrors with that status", async () => {
    const leg = (vars: Record<string, string>) =>
      ({ token: "", http: {} as ApiLeg["http"], env: (k: string) => vars[k] }) as ApiLeg;
    const searchApi = web.routes.find((r) => r.path === "/search")?.api as (
      i: unknown,
      l: ApiLeg,
    ) => Promise<unknown>;
    const readApi = web.routes.find((r) => r.path === "/read")?.api as (
      i: unknown,
      l: ApiLeg,
    ) => Promise<unknown>;
    const status = async (p: Promise<unknown>) => {
      const e = await p.catch((x: unknown) => x);
      expect(e).toBeInstanceOf(SiteError);
      return (e as SiteError).status;
    };
    expect(await status(searchApi({ q: "q", n: 5, via: ["bing"] }, leg({})))).toBe(400);
    expect(await status(searchApi({ q: "q", n: 5, via: ["exa", "brave"] }, leg({})))).toBe(501);
    expect(
      await status(readApi({ url: "https://x.test/?key=1", max: 500, via: ["jina"] }, leg({}))),
    ).toBe(501);
    expect(
      await status(readApi({ url: "https://x.test/", max: 500, via: ["nope"] }, leg({}))),
    ).toBe(400);
  });

  it("the site's via parser: `,` alone means the default order", () => {
    const req = web.routes.find((r) => r.path === "/search")?.request as unknown as {
      parse(v: unknown): { via?: string[] };
    };
    expect(req.parse({ q: "q", via: " brave , exa " }).via).toEqual(["brave", "exa"]);
    expect(req.parse({ q: "q" }).via).toBeUndefined();
    expect(req.parse({ q: "q", via: "," }).via).toBeUndefined();
  });
});
