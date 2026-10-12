import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlowRunner, HeldTab } from "../src/browser/flow.js";
import { SessionPark } from "../src/browser/park.js";
import type { Session } from "../src/browser/session.js";
import { Watchers, watchSkips } from "../src/browser/watchers.js";

const session = () => {
  const s = { closed: false };
  return Object.assign(s, {
    page: { evaluate: async () => 1 },
    close: async () => {
      s.closed = true;
    },
  }) as unknown as Session & { closed: boolean };
};

describe("SessionPark pins", () => {
  afterEach(() => vi.useRealTimers());

  it("a pinned browser outlives the idle limit and eviction, then idles out once unpinned", async () => {
    vi.useFakeTimers();
    const park = new SessionPark({ idleMs: 1_000, max: 1 });
    const a = session();
    const b = session();
    park.pin("a");
    await park.put("a", a);
    await park.put("b", b);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(a.closed).toBe(false);
    expect(b.closed).toBe(true);
    park.unpin("a");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(a.closed).toBe(true);
  });

  it("counts pins: two holders need two unpins", async () => {
    vi.useFakeTimers();
    const park = new SessionPark({ idleMs: 1_000, max: 2 });
    const a = session();
    park.pin("a");
    park.pin("a");
    await park.put("a", a);
    park.unpin("a");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(a.closed).toBe(false);
    park.unpin("a");
    expect(park.pinned("a")).toBe(false);
  });
});

/** A tab whose title the test sets; `close()` fires the page's close listeners. */
function fakeTab(titles: { now: string; url: string }) {
  const listeners: Array<() => void> = [];
  const page = {
    gone: false,
    goto: vi.fn(async () => null),
    reload: vi.fn(async () => null),
    route: vi.fn(async () => undefined),
    url: () => titles.url,
    title: async () => {
      if (page.gone) throw new Error("Target page, context or browser has been closed");
      return titles.now;
    },
    once: (_e: string, fn: () => void) => listeners.push(fn),
    close: async () => {
      if (page.gone) return;
      page.gone = true;
      for (const fn of listeners) fn();
    },
  };
  return page;
}

function harness(o: { shared?: boolean } = {}) {
  const titles = { now: "Feed | LinkedIn", url: "https://www.linkedin.com/my-items/saved-posts/" };
  const tabs: ReturnType<typeof fakeTab>[] = [];
  const released: string[] = [];
  const runner: FlowRunner = {
    run: async () => {
      throw new Error("no runs here");
    },
    tab: async (site: string): Promise<HeldTab> => {
      const page = fakeTab(titles);
      tabs.push(page);
      return {
        page: page as never,
        shared: o.shared === true,
        release: async () => {
          released.push(site);
          await page.close();
        },
      };
    },
  };
  const sent: Array<{ path: string; body: Record<string, unknown>; key: string }> = [];
  let now = Date.parse("2026-10-12T15:00:00Z");
  const file = join(mkdtempSync(join(tmpdir(), "autobrowse-watch-")), "watchers.json");
  const make = () =>
    new Watchers({
      runner,
      file,
      now: () => now,
      everyMs: 1_000,
      quietMs: 10_000,
      beatMs: 60_000,
      send: async (path, body, key) => {
        sent.push({ path, body, key });
      },
    });
  return {
    titles,
    tabs,
    released,
    sent,
    file,
    make,
    tick: async (ms: number) => {
      now += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
}

const lease = (until = "2026-10-12T16:00:00Z") => ({
  site: "linkedin",
  account: "linkedin@wren",
  sink: { path: "/SocialPush/watch/send", body: { owner: "wren", platform: "linkedin" } },
  until,
});

describe("watchSkips", () => {
  const site = "https://www.linkedin.com/my-items/saved-posts/";
  it("skips pictures, styles and another site's frames; keeps scripts, the page and its own frames", () => {
    const req = (type: string, host = "www.linkedin.com", subframe = false) => ({
      type,
      host,
      subframe,
    });
    expect(watchSkips(req("image"), site)).toBe(true);
    expect(watchSkips(req("stylesheet"), site)).toBe(true);
    expect(watchSkips(req("document", "ads.example.com", true), site)).toBe(true);
    expect(watchSkips(req("document"), site)).toBe(false);
    expect(watchSkips(req("document", "static.linkedin.com", true), site)).toBe(false);
    expect(watchSkips(req("script", "static.licdn.com"), site)).toBe(false);
    expect(watchSkips(req("websocket", "realtime.www.linkedin.com"), site)).toBe(false);
  });
});

describe("Watchers", () => {
  afterEach(() => vi.useRealTimers());

  it("opens a tab on the spec's page, images blocked, and sends once per rise in the title count", async () => {
    vi.useFakeTimers();
    const h = harness();
    const w = h.make();
    const state = await w.lease(lease());
    expect(state).toMatchObject({ id: "linkedin@wren", open: true, count: 0 });
    expect(h.tabs[0]?.goto).toHaveBeenCalledWith("https://www.linkedin.com/my-items/saved-posts/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    expect(h.tabs[0]?.route).toHaveBeenCalledTimes(1);

    h.titles.now = "(2) Feed | LinkedIn";
    await h.tick(1_000);
    const fired = () => h.sent.filter((x) => x.body.kind === "activity");
    expect(fired()).toEqual([
      {
        path: "/SocialPush/watch/send",
        body: { owner: "wren", platform: "linkedin", kind: "activity" },
        key: expect.stringMatching(/^watch-linkedin@wren-activity-\d+$/),
      },
    ]);
    // Same count: nothing. A fall (read elsewhere): nothing. A rise inside the quiet window: once, after it.
    await h.tick(1_000);
    h.titles.now = "(1) Feed | LinkedIn";
    await h.tick(1_000);
    h.titles.now = "(3) Feed | LinkedIn";
    await h.tick(1_000);
    expect(fired()).toHaveLength(1);
    await h.tick(10_000);
    expect(fired()).toHaveLength(2);
    await w.stop();
  });

  it("says it is alive every beat while the tab reads signed in, and never once it is signed out", async () => {
    vi.useFakeTimers();
    const h = harness();
    const w = h.make();
    await w.lease(lease());
    expect(h.sent.map((x) => x.body.kind)).toEqual(["alive"]);
    await h.tick(30_000);
    expect(h.sent).toHaveLength(1);
    await h.tick(30_000);
    expect(h.sent.map((x) => x.body.kind)).toEqual(["alive", "alive"]);
    h.titles.url = "https://www.linkedin.com/login";
    await h.tick(120_000);
    expect(h.sent).toHaveLength(2);
    await w.stop();
  });

  it("a title with no count shows in the state, so a stale spec is seen", async () => {
    vi.useFakeTimers();
    const h = harness();
    const w = h.make();
    h.titles.now = "Sign in | LinkedIn";
    const state = await w.lease(lease());
    expect(state).toMatchObject({ count: 0, title: "Sign in | LinkedIn" });
    expect(h.sent).toEqual([]);
    await w.stop();
  });

  it("reopens a closed tab after a backoff, and closes it when the lease lapses", async () => {
    vi.useFakeTimers();
    const h = harness();
    const w = h.make();
    w.start();
    await w.lease(lease("2026-10-12T15:10:00Z"));
    await h.tabs[0]?.close();
    expect(w.states()[0]).toMatchObject({ open: false, error: "the tab closed" });
    await h.tick(61_000);
    expect(h.tabs).toHaveLength(2);
    expect(w.states()[0]?.open).toBe(true);
    await h.tick(10 * 60_000);
    expect(w.states()).toEqual([]);
    expect(h.tabs[1]?.gone).toBe(true);
    await w.stop();
  });

  it("keeps leases in a file, so a restart reopens the live ones", async () => {
    vi.useFakeTimers();
    const h = harness();
    const w = h.make();
    await w.lease(lease());
    expect(JSON.parse(readFileSync(h.file, "utf8"))).toHaveLength(1);
    await w.stop();
    const again = h.make();
    again.start();
    await h.tick(0);
    expect(again.states().map((s) => s.id)).toEqual(["linkedin@wren"]);
    expect(h.tabs).toHaveLength(2);
    await again.stop();
  });

  it("never routes the person's own browser, and refuses a site with no spec or a sink that is not a send", async () => {
    vi.useFakeTimers();
    const h = harness({ shared: true });
    const w = h.make();
    await w.lease(lease());
    expect(h.tabs[0]?.route).not.toHaveBeenCalled();
    await expect(w.lease({ ...lease(), site: "myspace" })).rejects.toThrow(/no watch spec/);
    await expect(
      w.lease({ ...lease(), sink: { path: "/SocialPush/watch", body: {} } }),
    ).rejects.toThrow(/send/);
    await w.stop();
  });
});
