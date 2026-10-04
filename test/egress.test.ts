import { describe, expect, it } from "vitest";
import { egressOf, proxyOf } from "../src/browser/egress.js";

const SIGNS_IN = new Set(["x", "linkedin", "google"]);
const deps = { signsIn: (s: string) => SIGNS_IN.has(s), sleep: async () => {} };
const of = (env: Record<string, string>, more: Partial<Parameters<typeof egressOf>[1]> = {}) =>
  egressOf((n) => env[n], { ...deps, ...more });

describe("proxyOf", () => {
  it("parses http, https and socks5; host with port, v6 host, no port; decodes the login", () => {
    expect(proxyOf("http://u%40x:p%3Aw@isp.example:8080", "E")).toEqual({
      server: "http://isp.example:8080",
      username: "u@x",
      password: "p:w",
    });
    expect(proxyOf("HTTPS://User:Pw@Proxy.Example:443", "E")).toEqual({
      server: "https://proxy.example",
      username: "User",
      password: "Pw",
    });
    expect(proxyOf("http://[2001:db8::1]:8080", "E")).toEqual({
      server: "http://[2001:db8::1]:8080",
    });
    expect(proxyOf("socks5://h:1080", "E")).toEqual({ server: "socks5://h:1080" });
    expect(proxyOf("http://u@h:1", "E")).toEqual({ server: "http://h:1", username: "u" });
  });

  it("refuses bad URLs by the key's name, never echoing the URL", () => {
    expect(() => proxyOf("secret-pass@nohost", "EGRESS_ISP")).toThrow(/^EGRESS_ISP is not a URL/);
    expect(() => proxyOf("socks4://h:1080", "E")).toThrow(/http, https or socks5/);
    expect(() => proxyOf("socks5://u:p@h:1080", "E")).toThrow(/no login on a socks5/);
    expect(() => proxyOf("socks5://:secret@h:1080", "E")).toThrow(/no login on a socks5/);
    try {
      proxyOf("ftp://user:secret@h:1", "E");
    } catch (e) {
      expect(String(e)).not.toContain("secret");
    }
  });
});

describe("egress mapping", () => {
  const env = {
    EGRESS_SITES: " web:Mobile , LinkedIn@Research:isp, reddit:desk ",
    EGRESS_MOBILE: "http://m:pw@modem.lan:3128",
    EGRESS_MOBILE_ROTATE: "http://modem.lan/rotate?token=t",
    EGRESS_ISP: "http://u:p@isp.example:8080",
    EGRESS_ISP_TZ: "America/Chicago",
  };

  it("a site covers its profiles; a profile covers only itself; desk and unlisted go direct", () => {
    const e = of(env);
    expect(e.exitFor("web")).toMatchObject({ name: "mobile", rotates: true });
    expect(e.exitFor("web@two")?.name).toBe("mobile");
    expect(e.exitFor("linkedin@research")).toEqual({
      name: "isp",
      proxy: { server: "http://isp.example:8080", username: "u", password: "p" },
      timezone: "America/Chicago",
      rotates: false,
    });
    // His own `linkedin` stays on its own line.
    expect(e.exitFor("linkedin")).toBeNull();
    expect(e.exitFor("reddit")).toBeNull();
    expect(e.exitFor("x")).toBeNull();
    expect(e.exitFor("webx")).toBeNull();
  });

  it("describes mappings with no URLs", () => {
    const lines = of(env).describe();
    expect(lines).toEqual(["web → mobile (rotates)", "linkedin@research → isp", "reddit → desk"]);
    expect(lines.join(" ")).not.toMatch(/pw|token|modem/);
  });

  it("nothing set: every profile goes direct", () => {
    const e = of({});
    expect(e.exitFor("web")).toBeNull();
    expect(of({ EGRESS_SITES: " , " }).exitFor("web")).toBeNull();
  });

  it("* covers every profile not named", () => {
    const e = of({ EGRESS_SITES: "*:isp,web:desk", EGRESS_ISP: "http://h:1" });
    expect(e.exitFor("anything@else")?.name).toBe("isp");
    expect(e.exitFor("web")).toBeNull();
  });

  it("refuses config it cannot honor, naming the key", () => {
    expect(() => of({ EGRESS_SITES: "web" })).toThrow(/"web" is not <site or profile>:<exit>/);
    expect(() => of({ EGRESS_SITES: "web:mo-bile" })).toThrow(/is not <site/);
    expect(() => of({ EGRESS_SITES: "web:mobile" })).toThrow(/EGRESS_MOBILE is unset/);
    expect(() => of({ ...env, EGRESS_ISP_TZ: "America/Chicgo" })).toThrow(
      /EGRESS_ISP_TZ: not an IANA/,
    );
    expect(() => of({ ...env, EGRESS_MOBILE_ROTATE: "modem.lan/rotate" })).toThrow(
      /ROTATE needs an http/,
    );
    expect(() => of({ ...env, EGRESS_MOBILE_GAP: "-1" })).toThrow(/EGRESS_MOBILE_GAP/);
  });

  it("a rotating exit never serves a site we sign in to, nor *", () => {
    expect(() => of({ ...env, EGRESS_SITES: "x@wren:mobile" })).toThrow(
      /x@wren signs in, so it cannot use mobile/,
    );
    expect(() => of({ ...env, EGRESS_SITES: "*:mobile" })).toThrow(/\* signs in/);
    // A static exit may.
    expect(of({ ...env, EGRESS_SITES: "x@wren:isp" }).exitFor("x@wren")?.name).toBe("isp");
  });
});

describe("new IP", () => {
  const env = {
    EGRESS_SITES: "web:mobile,linkedin@research:isp",
    EGRESS_MOBILE: "http://modem.lan:3128",
    EGRESS_MOBILE_ROTATE: "http://modem.lan/rotate",
    EGRESS_ISP: "http://isp.example:8080",
  };
  const counting = (status = 200) => {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(url);
      return new Response("", { status });
    }) as unknown as typeof fetch;
    return { calls, f };
  };

  it("rotates through the URL, then waits the gap; two callers at once share one rotation", async () => {
    let t = 0;
    const { calls, f } = counting();
    const e = of(env, { fetch: f, now: () => t });
    const [a, b] = await Promise.all([e.newIp("web"), e.newIp("web@two")]);
    expect([a, b]).toEqual([true, true]);
    expect(calls).toEqual(["http://modem.lan/rotate"]);
    t = 60_000;
    expect(await e.newIp("web")).toBe(false);
    t = 120_000;
    expect(await e.newIp("web")).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("false for a static exit, the machine's line, or a failed rotate URL", async () => {
    const { calls, f } = counting(500);
    const e = of(env, { fetch: f });
    expect(await e.newIp("linkedin@research")).toBe(false);
    expect(await e.newIp("reddit")).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await e.newIp("web")).toBe(false);
    const thrown = of(env, {
      fetch: (async () => {
        throw new Error("down");
      }) as unknown as typeof fetch,
    });
    expect(await thrown.newIp("web")).toBe(false);
  });
});
