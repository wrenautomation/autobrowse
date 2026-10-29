import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startExplore } from "../src/explore/server.js";
import type { Approval } from "../src/gates/payment.js";
import { defineFlow, defineWorkflow, done, type FlowRunner } from "../src/index.js";
import { legWorkflow } from "../src/workflows/legs.js";

interface Deps {
  browser: FlowRunner;
}
const plan = z.object({ dryRun: z.boolean().default(false), q: z.string().default("dune") });

/** One leg on the session's site: search, read the answer. */
const search = (web: () => number, site = "shop", secret = false) =>
  defineFlow<{ q: string }, string>({
    site,
    name: "search",
    secret,
    async run(fp, input) {
      await fp.open(`http://localhost:${web()}/`);
      await fp.act(
        { kind: "fill", value: input.q },
        { role: "textbox", name: "Search" },
        {
          goal: "fill Search",
        },
      );
      await fp.act({ kind: "click" }, { role: "button", name: "Go" }, { goal: "click Go" });
      return fp.read({ css: "#out" });
    },
  });

describe("explore runs a compiled workflow on its page (flow)", () => {
  let dir: string;
  let web: Server;
  let webPort: number;
  let port: number;
  let done_: Promise<void>;
  let token: string;
  const asked: Approval[] = [];
  let yes = true;
  /** The human step fails until a person fixed the page (here: the test flips it). */
  let fixed = false;

  const wf = (name: string, run: (d: Deps, p: z.infer<typeof plan>) => Promise<string>) =>
    defineWorkflow<Deps, Record<string, never>>()({
      name,
      description: "test",
      plan,
      steps: [{ name: "go", run: async ({ deps, plan: p }) => done(await run(deps, p)) }],
      emptyMemo: () => ({}),
    });
  const flows = {
    // A hand-written leg, as the catalog holds it.
    "shop-search": legWorkflow(
      search(() => webPort),
      z.object({ q: z.string() }),
    ),
    search: wf("search", (d, p) =>
      d.browser.run(
        search(() => webPort),
        { q: p.q },
      ),
    ),
    elsewhere: wf("elsewhere", (d, p) =>
      d.browser.run(
        search(() => webPort, "amazon"),
        { q: p.q },
      ),
    ),
    secret: wf("secret", (d, p) =>
      d.browser.run(
        search(() => webPort, "shop", true),
        { q: p.q },
      ),
    ),
    buy: wf("buy", (d) =>
      d.browser.run(
        defineFlow<undefined, string>({
          site: "shop",
          name: "buy",
          async run(fp) {
            await fp.open(`http://localhost:${webPort}/`);
            await fp.act({ kind: "click" }, { role: "button", name: "Buy now" }, { goal: "buy" });
            return "bought";
          },
        }),
        undefined,
      ),
    ),
    stuck: wf("stuck", (d) =>
      d.browser.run(
        defineFlow<undefined, string>({
          site: "shop",
          name: "stuck",
          async run(fp) {
            await fp.open(`http://localhost:${webPort}/`);
            if (!fixed) fp.human("the page needs a person");
            return "past it";
          },
        }),
        undefined,
      ),
    ),
  };

  const send = async (cmd: Record<string, unknown>, wait = false) => {
    const r = await fetch(`http://127.0.0.1:${port}/${wait ? "?wait=1" : ""}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(cmd),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const journal = async () =>
    ((await send({ cmd: "journal" })).body.actions as Array<{ kind: string; text?: string }>) ?? [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "explore-flow-"));
    web = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        `<label>Search <input id="q"></label><button onclick="out.textContent='found '+q.value">Go</button><button>Buy now</button><p id="out"></p>`,
      );
    }).listen(0);
    webPort = (web.address() as AddressInfo).port;
    port = 9900 + Math.floor(Math.random() * 90);
    ({ done: done_, token } = await startExplore({
      site: "shop",
      port,
      tokenFile: join(dir, "explore.token"),
      yesFile: join(dir, "payment-flows.json"),
      idleMinutes: 0,
      approve: async (a) => {
        asked.push(a);
        return yes;
      },
      workflows: {
        get: async (name) => flows[name as keyof typeof flows] ?? null,
        plan: async (_name, given) => ({ q: "saved", ...given }),
      },
      recordingsDir: join(dir, "recordings"),
      browser: {
        tier: "local",
        channel: "chromium",
        profilesDir: join(dir, "profiles"),
        artifactsDir: join(dir, "artifacts"),
        headless: true,
      },
    }));
  }, 30_000);
  afterAll(async () => {
    await send({ cmd: "close" }).catch(() => undefined);
    await done_;
    web.close();
    await new Promise((r) => setTimeout(r, 500));
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("runs it here, its plan under saved defaults, and journals its acts flat", async () => {
    const r = await send({ cmd: "flow", name: "search", plan: { q: "dune" } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ flow: "search", status: "done" });
    expect((r.body.steps as { go: { detail: string } }).go.detail).toBe("found dune");
    // The page stays where the flow left it: the agent goes on by hand.
    const text = await send({ cmd: "read", hints: { css: "#out" }, as: "out" });
    expect(text.body.text).toBe("found dune");
    const kinds = (await journal()).map((a) => (a.kind === "note" ? a.text : a.kind));
    expect(kinds.slice(-6)).toEqual([
      "flow search start",
      "navigate",
      "input",
      "click",
      "flow search done",
      "read",
    ]);
  }, 30_000);

  it("runs a hand-written leg from the catalog the same way", async () => {
    const r = await send({ cmd: "flow", name: "shop-search", plan: { q: "leg" } });
    expect(r.body).toMatchObject({ flow: "shop-search", status: "done" });
    expect((r.body.steps as { search: { detail: string } }).search.detail).toBe('"found leg"');
    const kinds = (await journal()).map((a) => (a.kind === "note" ? a.text : a.kind));
    expect(kinds.slice(-5)).toEqual([
      "flow shop-search start",
      "navigate",
      "input",
      "click",
      "flow shop-search done",
    ]);
  }, 30_000);

  it("refuses a leg for another site's profile", async () => {
    const r = await send({ cmd: "flow", name: "elsewhere" });
    expect(r.body.status).toBe("failed");
    expect(JSON.stringify(r.body.steps)).toMatch(/open explore on amazon/);
  }, 30_000);

  it("a secret flow leaves only its notes in the journal", async () => {
    const before = (await journal()).length;
    const r = await send({ cmd: "flow", name: "secret", plan: { q: "x" } });
    expect(r.body.status).toBe("done");
    expect((await journal()).slice(before).map((a) => a.text)).toEqual([
      "flow secret start",
      "flow secret done",
    ]);
  }, 30_000);

  it("a money click asks the person first; a no refuses the act", async () => {
    yes = false;
    const r = await send({ cmd: "flow", name: "buy" }, true);
    expect(r.status).toBe(403);
    expect(asked.at(-1)?.what).toMatch(/Buy now/i);
    expect((await journal()).at(-1)?.text).toBe("flow buy stopped");
    yes = true;
    const again = await send({ cmd: "flow", name: "buy" }, true);
    expect(again.body).toMatchObject({ status: "done" });
  }, 30_000);

  it("a step that needs a person stops; the same command after the fix goes on", async () => {
    const r = await send({ cmd: "flow", name: "stuck" });
    expect(r.body).toMatchObject({ status: "waiting", gate: { name: "human", step: "go" } });
    fixed = true;
    const again = await send({ cmd: "flow", name: "stuck" });
    expect(again.body).toMatchObject({ status: "done" });
  }, 30_000);
});
