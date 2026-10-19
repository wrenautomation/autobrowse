import { afterEach, describe, expect, it, vi } from "vitest";
import { clearChallenge, type RenderedPage } from "../src/browser/render.js";
import {
  blockOf,
  climb,
  type Got,
  HostGap,
  NoExit,
  nextRung,
  type Rung,
  type Rungs,
  Transport,
  transportOf,
} from "../src/reach/ladder.js";
import type { ApiLeg } from "../src/sites/types.js";
import { web } from "../src/sites/web.js";

const words = (n: number) =>
  `<p>${"The firm plans your week and sends it on time. ".repeat(n)}</p>`;
const page = (html: string, status = 200, type = "text/html"): Got => ({
  finalUrl: "https://acme.test/",
  status,
  type,
  html,
});
const REAL = `<html><title>Acme</title><body>${words(40)}</body></html>`;

describe("blockOf", () => {
  const walls: [string, string, number][] = [
    ["cloudflare", '<form id="challenge-form"><script>window._cf_chl_opt={}</script></form>', 403],
    ["cloudflare", "<title>Just a moment...</title><p>Checking</p>", 503],
    ["cloudflare", "<title>Attention Required! | Cloudflare</title>", 403],
    ["cloudflare", '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script>', 200],
    [
      "turnstile",
      '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>',
      200,
    ],
    ["akamai", "<h1>Access Denied</h1><p>Reference #18.4c2e3f</p>", 403],
    ["akamai", '<a href="https://errors.edgesuite.net/18.1">x</a>', 200],
    ["datadome", '<script src="https://ct.captcha-delivery.com/c.js"></script>', 403],
    ["perimeterx", '<div id="px-captcha"></div>', 403],
    ["perimeterx", "<p>Press &amp; Hold to confirm</p>", 200],
    ["imperva", "<iframe src=/_Incapsula_Resource?x=1></iframe>", 200],
    ["imperva", "Request unsuccessful. Incapsula incident ID: 123-456", 403],
    ["sucuri", "<p>Sucuri WebSite Firewall - Access Denied</p>", 403],
    ["aws-waf", '<script src="https://x.token.awswaf.com/challenge.js"></script>', 405],
    ["vercel", "<title>Vercel Security Checkpoint</title>", 429],
    ["kasada", "<script>window.x-kpsdk-ct</script>", 429],
  ];
  it.each(walls)("%s: %s", (block, html, status) => {
    expect(blockOf(page(html, status))).toBe(block);
  });

  it("a bare 403, 429 or 503 is its own block; 401, 404, 410 and 500 are answers", () => {
    expect(blockOf(page("<p>no</p>", 403))).toBe("status-403");
    expect(blockOf(page("<p>slow down</p>", 429))).toBe("status-429");
    expect(blockOf(page("<p>busy</p>", 503))).toBe("status-503");
    for (const status of [401, 404, 410, 500])
      expect(blockOf(page("<p>gone</p>", status))).toBeNull();
  });

  it("a marker beats a bare status", () => {
    expect(blockOf(page("<title>Just a moment...</title>", 403))).toBe("cloudflare");
  });

  it("a marker on a real page of words is not a block", () => {
    const body = `<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>${words(40)}`;
    expect(blockOf(page(`<html><body>${body}</body></html>`))).toBeNull();
  });

  it("a real page with a Turnstile contact form is not a block", () => {
    const form =
      '<form><div class="cf-turnstile"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></form>';
    expect(blockOf(page(`<html><body>${words(40)}${form}</body></html>`))).toBeNull();
  });

  it("a marker on a 4xx page counts whatever the text", () => {
    expect(blockOf(page(`<html>${words(60)}<p>datadome</p></html>`, 403))).toBe("datadome");
  });

  it("a JS shell is a block; a thin server-rendered page is not", () => {
    const shell = `<html><head>${"<script src=/a.js></script>".repeat(3)}</head><body><div id="root"></div>${" ".repeat(2100)}</body></html>`;
    expect(blockOf(page(shell))).toBe("shell");
    expect(blockOf(page("<html><body><p>Call us on 555 0100.</p></body></html>"))).toBeNull();
    expect(blockOf(page('{"ok":true}', 200, "application/json"))).toBeNull();
  });
});

describe("nextRung", () => {
  it("climbs in order and stops after exit", () => {
    expect(nextRung("plain", "status-403")).toBe("impersonate");
    expect(nextRung("impersonate", "cloudflare")).toBe("render");
    expect(nextRung("render", "cloudflare")).toBe("exit");
    expect(nextRung("exit", "cloudflare")).toBeNull();
  });
  it("a shell goes to render, skipping impersonate", () => {
    expect(nextRung("plain", "shell")).toBe("render");
    expect(nextRung("impersonate", "shell")).toBe("render");
    expect(nextRung("render", "shell")).toBe("exit");
  });
  it("a reset climbs one rung", () => {
    expect(nextRung("plain", "reset")).toBe("impersonate");
  });
});

describe("transportOf", () => {
  const withCause = (message: string, code: string) =>
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error(message), { code }),
    });
  it("names resets, dead hosts and leaves the rest", () => {
    expect(transportOf(withCause("read ECONNRESET", "ECONNRESET"))).toBe("reset");
    expect(
      transportOf(withCause("handshake failure", "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE")),
    ).toBe("reset");
    expect(transportOf(withCause("getaddrinfo ENOTFOUND x.test", "ENOTFOUND"))).toBe("unreachable");
    expect(transportOf(withCause("connect ECONNREFUSED", "ECONNREFUSED"))).toBe("unreachable");
    expect(transportOf(new DOMException("The operation timed out", "TimeoutError"))).toBe(
      "unreachable",
    );
    expect(transportOf(new Error("net::ERR_NAME_NOT_RESOLVED at https://x.test/"))).toBe(
      "unreachable",
    );
    expect(transportOf(new Error("boom"))).toBeNull();
  });
});

/** Rungs that answer from a script and count their calls. */
function fakes(answers: Partial<Record<keyof Rungs, Got | Error>>) {
  const calls: string[] = [];
  const rung = (tier: string, a: Got | Error | undefined): Rung | undefined =>
    a === undefined
      ? undefined
      : async () => {
          calls.push(tier);
          if (a instanceof Error) throw a;
          return a;
        };
  const rungs: Rungs = {
    plain: rung("plain", answers.plain ?? page(REAL)) as Rung,
    impersonate: rung("impersonate", answers.impersonate ?? page(REAL)) as Rung,
  };
  const render = rung("render", answers.render);
  const exit = rung("exit", answers.exit);
  if (render) rungs.render = render;
  if (exit) rungs.exit = exit;
  return { rungs, calls };
}

/** A gap that never waits, so these tests run at once. */
const noWait = {
  gap: new HostGap(
    2_000,
    () => 0,
    async () => undefined,
  ),
};
const go = (
  rungs: Rungs,
  o: { from?: "plain" | "impersonate" | "render" | "exit"; max?: number } = {},
) => climb("https://acme.test/", o, rungs, noWait);

describe("climb", () => {
  it("a plain page stays on plain", async () => {
    const { rungs, calls } = fakes({});
    const r = await go(rungs);
    expect(calls).toEqual(["plain"]);
    expect(r).toMatchObject({ tier: "plain", block: null, status: 200, cut: 0 });
    expect(r.tries).toEqual([{ tier: "plain", status: 200, block: null, ms: expect.any(Number) }]);
  });

  it("a 403 climbs to impersonate, which works", async () => {
    const { rungs, calls } = fakes({ plain: page("<p>no</p>", 403) });
    const r = await go(rungs);
    expect(calls).toEqual(["plain", "impersonate"]);
    expect(r).toMatchObject({ tier: "impersonate", block: null });
    expect(r.tries.map((t) => [t.tier, t.block])).toEqual([
      ["plain", "status-403"],
      ["impersonate", null],
    ]);
  });

  it("a shell skips impersonate and renders", async () => {
    const shell = `<html><div id="root"></div>${"<script></script>".repeat(4)}${" ".repeat(2100)}</html>`;
    const { rungs, calls } = fakes({ plain: page(shell), render: page(REAL) });
    const r = await go(rungs);
    expect(calls).toEqual(["plain", "render"]);
    expect(r).toMatchObject({ tier: "render", block: null });
    expect(r.tries[0]?.block).toBe("shell");
  });

  it("climbs the whole ladder to exit", async () => {
    const wall = page("<title>Just a moment...</title>", 403);
    const { rungs, calls } = fakes({
      plain: wall,
      impersonate: wall,
      render: wall,
      exit: page(REAL),
    });
    const r = await go(rungs);
    expect(calls).toEqual(["plain", "impersonate", "render", "exit"]);
    expect(r).toMatchObject({ tier: "exit", block: null });
    expect(r.tries.map((t) => t.block)).toEqual(["cloudflare", "cloudflare", "cloudflare", null]);
  });

  it("a wall at the last rung comes back as data, with its page", async () => {
    const wall = page("<title>Just a moment...</title>", 403);
    const { rungs } = fakes({ plain: wall, impersonate: wall, render: wall, exit: wall });
    const r = await go(rungs);
    expect(r).toMatchObject({ tier: "exit", block: "cloudflare", status: 403 });
    expect(r.html).toContain("Just a moment");
  });

  it("exit with no exit mapped stops with no-exit, keeping the render page", async () => {
    const wall = page("<title>Just a moment...</title>", 403);
    const { rungs, calls } = fakes({
      plain: wall,
      impersonate: wall,
      render: wall,
      exit: new NoExit(),
    });
    const r = await go(rungs);
    expect(calls).toEqual(["plain", "impersonate", "render", "exit"]);
    expect(r).toMatchObject({ tier: "render", block: "no-exit", status: 403 });
    expect(r.tries.at(-1)).toMatchObject({ tier: "exit", status: null, block: "no-exit" });
  });

  it("a leg with a render but no exit rung is no-exit too", async () => {
    const wall = page("<title>Just a moment...</title>", 403);
    const { rungs } = fakes({ plain: wall, impersonate: wall, render: wall });
    expect((await go(rungs)).block).toBe("no-exit");
  });

  it("a leg with no browser stops after impersonate with the block as found", async () => {
    const wall = page("<p>no</p>", 403);
    const { rungs, calls } = fakes({ plain: wall, impersonate: wall });
    const r = await go(rungs);
    expect(calls).toEqual(["plain", "impersonate"]);
    expect(r).toMatchObject({ tier: "impersonate", block: "status-403" });
  });

  it("an ask for render on a leg with no browser starts at impersonate", async () => {
    const { rungs, calls } = fakes({});
    expect((await go(rungs, { from: "render" })).tier).toBe("impersonate");
    expect(calls).toEqual(["impersonate"]);
  });

  it("starts where it is told", async () => {
    const { rungs, calls } = fakes({ render: page(REAL), exit: page(REAL) });
    expect((await go(rungs, { from: "render" })).tier).toBe("render");
    expect((await go(rungs, { from: "exit" })).tier).toBe("exit");
    expect(calls).toEqual(["render", "exit"]);
  });

  it("an unreachable host stops where it is", async () => {
    const { rungs, calls } = fakes({
      plain: new Transport("unreachable", "getaddrinfo ENOTFOUND"),
    });
    const r = await go(rungs);
    expect(calls).toEqual(["plain"]);
    expect(r).toMatchObject({ tier: "plain", block: "unreachable", status: null, html: "" });
  });

  it("a reset on plain climbs; a raw fetch failure is named from its cause", async () => {
    const cut = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    const { rungs, calls } = fakes({ plain: cut });
    const r = await go(rungs);
    expect(calls).toEqual(["plain", "impersonate"]);
    expect(r).toMatchObject({ tier: "impersonate", block: null });
    expect(r.tries[0]).toMatchObject({ tier: "plain", status: null, block: "reset" });
  });

  it("an error that is not the network's is thrown", async () => {
    const { rungs } = fakes({ plain: new Error("browser did not launch") });
    await expect(go(rungs)).rejects.toThrow("browser did not launch");
  });

  it("cuts html to max and counts the cut", async () => {
    const { rungs } = fakes({ plain: page("x".repeat(500)) });
    const r = await go(rungs, { max: 100 });
    expect(r.html).toHaveLength(100);
    expect(r.cut).toBe(400);
  });
});

describe("per-host gap", () => {
  it("waits 2 s between requests to one host, across rungs; other hosts do not wait", async () => {
    let t = 0;
    const slept: number[] = [];
    const gap = new HostGap(
      2_000,
      () => t,
      async (ms) => {
        slept.push(ms);
        t += ms;
      },
    );
    const wall = page("<p>no</p>", 403);
    const { rungs } = fakes({ plain: wall, impersonate: wall });
    await climb("https://a.test/", {}, rungs, { gap, now: () => t });
    expect(slept).toEqual([2_000]);
    await climb("https://b.test/", { from: "impersonate" }, rungs, { gap, now: () => t });
    expect(slept).toEqual([2_000]);
    t += 500;
    await climb("https://a.test/x", { from: "impersonate" }, rungs, { gap, now: () => t });
    expect(slept).toEqual([2_000, 1_500]);
  });

  it("two overlapping callers on one host queue", async () => {
    const t = 0;
    const slept: number[] = [];
    const gap = new HostGap(
      2_000,
      () => t,
      async (ms) => void slept.push(ms),
    );
    await Promise.all([gap.wait("a.test"), gap.wait("a.test"), gap.wait("a.test")]);
    expect(slept).toEqual([2_000, 4_000]);
  });
});

describe("clearChallenge", () => {
  const wall = (): RenderedPage => ({
    finalUrl: "https://acme.test/",
    status: 503,
    type: "text/html",
    html: "<title>Just a moment...</title>",
  });
  const real = (): RenderedPage => ({ ...wall(), status: 200, html: REAL });

  it("a page with no challenge is read once", async () => {
    const read = vi.fn(async () => real());
    const sleep = vi.fn(async () => undefined);
    await clearChallenge(read, sleep);
    expect(read).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("polls each second until the challenge clears", async () => {
    const reads = [wall(), wall(), real()];
    const sleep = vi.fn(async () => undefined);
    const got = await clearChallenge(async () => reads.shift() as RenderedPage, sleep);
    expect(got.status).toBe(200);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("gives up after 15 s and returns the wall", async () => {
    const sleep = vi.fn(async () => undefined);
    const got = await clearChallenge(async () => wall(), sleep);
    expect(sleep).toHaveBeenCalledTimes(15);
    expect(got.status).toBe(503);
  });
});

describe("/fetch route", () => {
  const route = web.routes.find((r) => r.path === "/fetch");
  const parse = (q: Record<string, string>) => route?.request.safeParse(q);
  const api = route?.api as (i: unknown, l: ApiLeg) => Promise<Record<string, unknown>>;
  afterEach(() => vi.unstubAllGlobals());

  it("defaults: plain, 2 000 000 characters", () => {
    expect(parse({ url: "https://acme.test/" })?.data).toEqual({
      url: "https://acme.test/",
      from: "plain",
      max: 2_000_000,
    });
  });

  it("refuses what is not an http(s) URL, an unknown rung, a max out of range", () => {
    expect(parse({ url: "ftp://acme.test/" })?.success).toBe(false);
    expect(parse({ url: "not a url" })?.success).toBe(false);
    expect(parse({ url: "https://acme.test/", from: "tor" })?.success).toBe(false);
    expect(parse({ url: "https://acme.test/", max: "9999" })?.success).toBe(false);
    expect(parse({ url: "https://acme.test/", max: "5000001" })?.success).toBe(false);
    expect(parse({ url: "https://acme.test/", from: "exit", max: "10000" })?.success).toBe(true);
  });

  it("meters one of the fetch bucket, whose cap is 1500", () => {
    expect(route?.meter?.({} as never)).toEqual({ fetch: 1 });
    expect(web.caps?.fetch).toBe(1500);
  });

  it("answers the Fetched shape from the plain rung", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(REAL, { headers: { "content-type": "text/html" } })),
    );
    const leg = { token: "", http: {} as ApiLeg["http"], env: () => undefined } as ApiLeg;
    const out = await api({ url: "https://plain.test/", from: "plain", max: 2_000_000 }, leg);
    expect(Object.keys(out).sort()).toEqual(
      ["block", "cut", "finalUrl", "html", "status", "tier", "tries", "type", "url"].sort(),
    );
    expect(out).toMatchObject({
      url: "https://plain.test/",
      status: 200,
      type: "text/html",
      cut: 0,
      tier: "plain",
      block: null,
    });
  });

  it("starts at render through the leg's browser; a wall comes back as data", async () => {
    const render = vi.fn(async (_url: string, o: { profile: string }) => ({
      finalUrl: "https://walled.test/",
      status: 403,
      type: "text/html",
      html: o.profile === "fetch" ? "<title>Just a moment...</title>" : "<p>never</p>",
    }));
    const leg = {
      token: "",
      http: {} as ApiLeg["http"],
      env: () => undefined,
      render: (u: string, o: { profile: "fetch" | "fetch@exit" }) => {
        if (o.profile === "fetch@exit") throw new NoExit();
        return render(u, o);
      },
    } as unknown as ApiLeg;
    const out = await api({ url: "https://walled.test/", from: "render", max: 2_000_000 }, leg);
    expect(out).toMatchObject({ tier: "render", block: "no-exit", status: 403 });
    expect(render).toHaveBeenCalledTimes(1);
  });
});
