/**
 * What a local launch hands Chrome for a proxied profile: the WebRTC flag and
 * the proxy's time zone. Patchright is faked; no browser starts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Egress } from "../src/browser/egress.js";
import type { BrowserOptions } from "../src/browser/session.js";

type Launch = { args: string[]; proxy?: unknown; env?: Record<string, string | undefined> };
const launches: Launch[] = [];

vi.mock("patchright", () => {
  const page = { on: () => undefined };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    on: () => undefined,
    close: async () => undefined,
  };
  return {
    chromium: {
      launchPersistentContext: async (_dir: string, o: Launch) => {
        launches.push(o);
        return context;
      },
    },
  };
});
vi.mock("../src/browser/reap.js", () => ({
  reapOrphans: async () => [],
  reapTempDirs: async () => undefined,
}));
vi.mock("../src/browser/webauthn.js", () => ({
  virtualAuthenticator: () => ({ export: async () => [] }),
}));
vi.mock("../src/browser/identity.js", async (orig) => ({
  ...(await orig<typeof import("../src/browser/identity.js")>()),
  // The launched browser already says the headed identity: no relaunch.
  learnIdentity: async () => ({ headless: false, identity: {} }),
}));

const opts = (o: Partial<BrowserOptions> = {}): BrowserOptions => ({
  tier: "local",
  profilesDir: "/nonexistent/profiles",
  artifactsDir: "/nonexistent/artifacts",
  channel: "chrome",
  ...o,
});
const PROXY = { server: "http://isp.example:8080" };
/** One exit for the profiles starting with `site`, saying `timezone` when given. */
const egressFor = (site: string, timezone?: string): Egress => ({
  exitFor: (profile) =>
    profile.startsWith(site)
      ? { name: "isp", proxy: PROXY, rotates: false, ...(timezone ? { timezone } : {}) }
      : null,
  newIp: async () => false,
  describe: () => [],
});

async function launchOf(site: string, o: Partial<BrowserOptions>): Promise<Launch> {
  const { openSession } = await import("../src/browser/session.js");
  launches.length = 0;
  await openSession(site, opts(o));
  const got = launches.at(-1);
  if (!got) throw new Error("nothing launched");
  return got;
}

const WEBRTC = "--webrtc-ip-handling-policy=disable_non_proxied_udp";

describe("local launch behind a proxy", () => {
  it("proxied: the proxy, WebRTC held to it, and the exit's zone", async () => {
    const l = await launchOf("x", {
      egress: egressFor("x", "America/Chicago"),
      timezone: "America/New_York",
    });
    expect(l.proxy).toEqual(PROXY);
    expect(l.args).toContain(WEBRTC);
    expect(l.env?.TZ).toBe("America/Chicago");
  });

  it("proxied with no exit zone: falls back to the browser's zone", async () => {
    const l = await launchOf("x", { egress: egressFor("x"), timezone: "America/New_York" });
    expect(l.env?.TZ).toBe("America/New_York");
  });

  it("not proxied: no proxy, no WebRTC flag, only the plain zone", async () => {
    const l = await launchOf("google", {
      egress: egressFor("x", "America/Chicago"),
      timezone: "America/New_York",
    });
    expect(l.proxy).toBeUndefined();
    expect(l.args).not.toContain(WEBRTC);
    expect(l.env?.TZ).toBe("America/New_York");
  });

  it("not proxied, only an exit's zone set: the machine's zone (no env)", async () => {
    const l = await launchOf("google", { egress: egressFor("x", "America/Chicago") });
    expect(l.env).toBeUndefined();
  });

  it("the profile, not the site, picks the proxy", async () => {
    const l = await launchOf("linkedin", {
      profile: "x@research",
      egress: egressFor("x@research", "America/Chicago"),
    });
    expect(l.proxy).toEqual(PROXY);
    expect(l.env?.TZ).toBe("America/Chicago");
  });

  it("always hides the automation flag", async () => {
    const l = await launchOf("google", {});
    expect(l.args).toContain("--disable-blink-features=AutomationControlled");
  });
});

describe("software WebGL flag by platform", () => {
  const real = process.platform;
  const setPlatform = (p: NodeJS.Platform) =>
    Object.defineProperty(process, "platform", { value: p, configurable: true });
  beforeEach(() => vi.resetModules());
  afterEach(() => setPlatform(real));

  it("on linux turns SwiftShader back on", async () => {
    setPlatform("linux");
    const l = await launchOf("google", {});
    expect(l.args).toContain("--enable-unsafe-swiftshader");
  });

  it("on a Mac leaves the GPU alone", async () => {
    setPlatform("darwin");
    const l = await launchOf("google", {});
    expect(l.args).not.toContain("--enable-unsafe-swiftshader");
  });
});
