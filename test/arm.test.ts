import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { BrowserFlow, FlowRunner, HeldTab } from "../src/browser/flow.js";
import { defineFlow } from "../src/browser/flow.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { ARM_MS, route, type SiteApi, siteFacade } from "../src/sites/index.js";
import { fakeFetch } from "./fakes.js";

const reply = defineFlow<{ id: string; text: string }, { sent: string }>({
  site: "chirp",
  name: "reply",
  async prepare() {},
  async run(_fp, { text }) {
    return { sent: text };
  },
});
const like = defineFlow<{ id: string }, { liked: true }>({
  site: "chirp",
  name: "like",
  async run() {
    return { liked: true };
  },
});

const chirp: SiteApi = {
  site: "chirp",
  origin: "https://chirp.test",
  auth: { open: true },
  routes: [
    route({
      method: "POST",
      path: "/posts/{id}/replies",
      summary: "reply",
      request: z.object({ id: z.string(), text: z.string() }),
      browser: { flow: "chirp/reply" },
    }),
    route({
      method: "POST",
      path: "/posts/{id}/like",
      summary: "like",
      request: z.object({ id: z.string() }),
      browser: { flow: "chirp/like" },
    }),
  ],
  setup: [],
};

/** A runner that records each run's flow name and whether it ran in an armed tab. */
function harness() {
  const runs: Array<{ name: string; tab: number | null }> = [];
  const tabs: Array<{ closed: boolean; released: boolean }> = [];
  const runner: FlowRunner = {
    async run(flow: BrowserFlow<unknown, unknown>, input: unknown, on?: { page: unknown }) {
      const tab = on ? tabs.findIndex((t) => (t as unknown) === (on.page as { t: unknown }).t) : -1;
      runs.push({ name: flow.name, tab: tab >= 0 ? tab : null });
      return flow.run({} as never, input);
    },
    async tab(): Promise<HeldTab> {
      const t = { closed: false, released: false };
      tabs.push(t);
      return {
        page: { t, isClosed: () => t.closed } as never,
        shared: false,
        release: async () => {
          t.released = true;
          t.closed = true;
        },
      };
    },
  };
  const sites = siteFacade([chirp], {
    http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
    env: () => undefined,
    sink: memorySink(),
    runner,
    flow: (n) => (n === "chirp/reply" ? reply : n === "chirp/like" ? like : null) as never,
  });
  return { sites, runs, tabs };
}

const replyCall = { id: "1", text: "thanks" };

describe("armed calls", () => {
  afterEach(() => vi.useRealTimers());

  it("arming runs only prepare, in its own tab; the call with the id commits there and frees it", async () => {
    const { sites, runs, tabs } = harness();
    const armed = (await sites.call("chirp", "POST", "/posts/1/replies", replyCall, null, {
      arm: true,
    })) as { armed: string; until: string };
    expect(armed.armed).toMatch(/^[0-9a-f-]{36}$/);
    expect(runs).toEqual([{ name: "reply.prepare", tab: 0 }]);
    const out = await sites.call("chirp", "POST", "/posts/1/replies", replyCall, null, {
      armId: armed.armed,
    });
    expect(out).toEqual({ sent: "thanks" });
    expect(runs.at(-1)).toEqual({ name: "reply", tab: 0 });
    expect(tabs[0]?.released).toBe(true);
    // The id is spent: a second call runs the whole leg in the browser's page.
    await sites.call("chirp", "POST", "/posts/1/replies", replyCall, null, { armId: armed.armed });
    expect(runs.at(-1)).toEqual({ name: "reply", tab: null });
  });

  it("a call to the same path takes the newest arm without its id; another path does not", async () => {
    const { sites, runs } = harness();
    await sites.call("chirp", "POST", "/posts/1/replies", replyCall, null, { arm: true });
    await sites.call("chirp", "POST", "/posts/2/replies", replyCall, null, {});
    expect(runs.at(-1)).toEqual({ name: "reply", tab: null });
    await sites.call("chirp", "POST", "/posts/1/replies", replyCall, null, {});
    expect(runs.at(-1)).toEqual({ name: "reply", tab: 0 });
  });

  it("matches on the target, not the words: an edited reply still takes the arm", async () => {
    const { sites, runs } = harness();
    await sites.call("chirp", "POST", "/posts/1/replies", replyCall, null, { arm: true });
    await sites.call("chirp", "POST", "/posts/1/replies", { id: "1", text: "edited" }, null, {});
    expect(runs.at(-1)).toEqual({ name: "reply", tab: 0 });
  });

  it("arms nothing for a flow with no prepare, or a read", async () => {
    const { sites, tabs } = harness();
    expect(
      await sites.call("chirp", "POST", "/posts/1/like", { id: "1" }, null, { arm: true }),
    ).toEqual({ armed: null });
    expect(tabs).toEqual([]);
  });

  it("a lapsed arm frees its tab and the call runs the whole leg", async () => {
    vi.useFakeTimers();
    const { sites, runs, tabs } = harness();
    const { armed } = (await sites.call("chirp", "POST", "/posts/1/replies", replyCall, null, {
      arm: true,
    })) as { armed: string };
    await vi.advanceTimersByTimeAsync(ARM_MS + 1);
    expect(tabs[0]?.released).toBe(true);
    await sites.call("chirp", "POST", "/posts/1/replies", replyCall, null, { armId: armed });
    expect(runs.at(-1)).toEqual({ name: "reply", tab: null });
  });

  it("keeps at most three arms per browser, the oldest going first", async () => {
    const { sites, tabs } = harness();
    for (let i = 0; i < 4; i++)
      await sites.call("chirp", "POST", `/posts/${i}/replies`, replyCall, null, { arm: true });
    expect(tabs.map((t) => t.released)).toEqual([true, false, false, false]);
  });
});
