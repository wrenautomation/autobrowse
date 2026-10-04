import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentSessions, SessionView } from "../src/agent/sessions.js";
import type { Ingress } from "../src/app/client.js";
import { signLinqWebhook } from "../src/clients/linq.js";
import type { Outline } from "../src/compiler/index.js";
import type { OpenGate, RunStatusView } from "../src/engine/object.js";
import { cursorOf, type ListQuery, pageOf, placeRow, type RunRow } from "../src/engine/registry.js";
import { saveRecording } from "../src/recorder/store.js";
import { SiteError, type SiteFacade } from "../src/sites/index.js";
import { api, findRow } from "../src/ui/api.js";
import { eventBus } from "../src/ui/bus.js";
import { domainWorkflow } from "../src/workflows/domain/index.js";

const gate: OpenGate = {
  name: "purchase",
  step: "buy",
  prompt: "Buy x.com?",
  openedAt: "2026-09-19T12:00:00Z",
};

/** One waiting run and a log of every ingress call. */
function fakeIngress() {
  const calls: string[] = [];
  const rows: RunRow[] = [
    {
      workflow: "domain",
      key: "x.com",
      startedAt: "t",
      updatedAt: "t",
      status: "waiting",
      gate: "purchase",
      lastStep: "check",
    },
  ];
  const run = {
    run: async (plan: unknown) => void calls.push(`run ${JSON.stringify(plan)}`),
    step: async () => undefined,
    pause: async () => void calls.push("pause"),
    play: async () => void calls.push("play"),
    reset: async () => void calls.push("reset"),
    approve: async (a: { name: string; note?: string }) => {
      calls.push(`approve ${a.name} ${a.note ?? ""}`);
      return gate;
    },
    reject: async (a: { name: string; note?: string }) => {
      calls.push(`reject ${a.name} ${a.note ?? ""}`);
      return gate;
    },
    status: async (): Promise<RunStatusView> => ({
      workflow: "domain",
      key: "x.com",
      plan: {},
      gate,
      paused: false,
      outcome: null,
    }),
  };
  const ingress = {
    run: () => run,
    registry: () => ({
      list: async (q: ListQuery) => pageOf(rows, q),
      record: async () => undefined,
      forget: async () => undefined,
    }),
  } as unknown as Ingress;
  return { ingress, calls };
}

const fakeAccounts = {
  list: async () => [
    {
      site: "instantly",
      known: true,
      ask: null,
      username: "a",
      via: null,
      url: null,
      has: {
        password: true,
        totpSecret: false,
        passkeys: false,
        recoveryCodes: false,
        codesInbox: false,
      },
    },
  ],
  save: async (site: string, edit: { username?: string }) => {
    if (!edit.username) throw new Error("a credential has a password or a via provider");
    return { ...(await fakeAccounts.list())[0], site, username: edit.username };
  },
  check: async (site: string) => `signed in to ${site}`,
};

async function setup(token?: string, extra: Partial<Parameters<typeof api>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "api-"));
  const recordingsDir = join(dir, "rec");
  await saveRecording(recordingsDir, {
    name: "chore",
    site: "scratch",
    startedAt: "2026-09-19T10:00:00Z",
    finishedAt: "2026-09-19T10:01:00Z",
    actions: [{ t: 0, kind: "navigate", url: "https://x.test/a" }],
    trace: null,
    terminal: null,
    commands: ["echo hi"],
  });
  await writeFile(join(recordingsDir, "chore", "shot.png"), "png");
  const { ingress, calls } = fakeIngress();
  const bus = eventBus();
  const app = api({
    workflows: [domainWorkflow],
    ingress,
    bus,
    screen: { headless: true },
    accounts: fakeAccounts,
    do: {
      do: async (req) => ({
        via: req.dryRun ? "none" : "site",
        name: req.dryRun ? null : "tube POST /v1/videos",
        input: req.inputs ?? {},
        output: req.dryRun ? null : { id: "v1" },
        status: req.dryRun ? "planned" : "done",
        built: null,
        session: null,
        summary: req.dryRun ? "nothing does this yet" : "tube POST /v1/videos answered",
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    },
    abilities: async () => [
      {
        kind: "site",
        name: "tube POST /v1/videos",
        site: "tube",
        summary: "upload",
        inputs: [{ name: "file" }],
        irreversible: true,
        ready: true,
        missing: null,
      },
    ],
    recordingsDir,
    artifactsDir: join(dir, "art"),
    compile: async (rec) => ({
      outline: { name: rec.name } as never,
      usage: null,
      files: { "index.ts": "//" },
    }),
    token,
    ...extra,
  });
  return { app, calls, bus, dir };
}

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://x${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? null : JSON.stringify(body),
  });

describe("api", () => {
  it("lists workflows with a JSON schema for the plan", async () => {
    const { app } = await setup();
    const body = await (await app.request("/api/workflows")).json();
    expect(body[0].name).toBe("domain");
    expect(body[0].steps.find((s: { name: string }) => s.name === "buy").irreversible).toBe(true);
    expect(body[0].plan.properties.domain).toBeDefined();
  });

  it("status carries the live workflow list and today's model spend", async () => {
    let used = 5;
    const { app } = await setup(undefined, {
      status: { llm: "fake", budget: { cap: 100, usedToday: 0 }, workflows: [] } as never,
      workflows: async () => [domainWorkflow],
      budget: () => ({ cap: 100, usedToday: used }),
    });
    expect(await (await app.request("/api/status")).json()).toMatchObject({
      workflows: ["domain"],
      budget: { cap: 100, usedToday: 5 },
    });
    used = 50;
    expect((await (await app.request("/api/status")).json()).budget.usedToday).toBe(50);
  });

  it("serves the owed list and the account policy; a decision is marked done and undone; 501 without them", async () => {
    const marks: Record<string, string | undefined> = {};
    const purposes: Record<string, string[]> = { "w@wren.test": ["default"] };
    const { app } = await setup(undefined, {
      owed: {
        rows: async () => ({
          titles: { decision: "Decisions" } as never,
          rows: [
            {
              id: "linkedin-page",
              kind: "decision",
              what: "A Page",
              unlocks: "posts",
              how: ["autobrowse needs done linkedin-page"],
              done: "linkedin-page" in marks,
              by: "linkedin-page" in marks ? "you" : null,
              checked: false,
            },
          ],
        }),
        done: async (id, note) => {
          marks[id] = note;
        },
        undo: async (id) => {
          delete marks[id];
        },
      },
      policy: {
        list: async () => ({
          purposes: { default: "the rest", pays: "cards" },
          accounts: Object.entries(purposes).map(([address, f]) => ({
            address,
            at: "google" as const,
            for: f,
            credential: null,
            inbox: null,
            tokens: [],
          })),
        }),
        use: async (purpose, address) => {
          purposes[address] = [...(purposes[address] ?? []), purpose];
          return [];
        },
      },
    });
    expect((await (await app.request("/api/needs")).json()).rows[0]).toMatchObject({
      id: "linkedin-page",
      done: false,
    });
    await app.request(post("/api/needs/linkedin-page/done", { note: "Wren's own" }));
    expect(marks["linkedin-page"]).toBe("Wren's own");
    expect((await (await app.request("/api/needs")).json()).rows[0].by).toBe("you");
    await app.request(new Request("http://x/api/needs/linkedin-page/done", { method: "DELETE" }));
    expect("linkedin-page" in marks).toBe(false);
    const used = await app.request(
      new Request("http://x/api/policy/use", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ purpose: "pays", address: "w@wren.test" }),
      }),
    );
    expect((await used.json()).accounts[0].for).toEqual(["default", "pays"]);
    expect(
      (
        await app.request(
          new Request("http://x/api/policy/use", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(400);
    const bare = await setup();
    expect((await bare.app.request("/api/needs")).status).toBe(501);
    expect((await bare.app.request("/api/policy")).status).toBe(501);
  });

  it("serves both ledgers since a time, 501 without one", async () => {
    const asked: string[] = [];
    const { app } = await setup(undefined, {
      ledger: async (since: Date) => {
        asked.push(since.toISOString());
        return { since: since.toISOString(), secrets: [], spend: [] };
      },
    });
    const res = await app.request("/api/ledger?since=2026-09-22T09:00:00Z");
    expect(res.status).toBe(200);
    expect(asked).toEqual(["2026-09-22T09:00:00.000Z"]);
    expect((await app.request("/api/ledger?since=yesterday")).status).toBe(400);
    const bare = await setup();
    expect((await bare.app.request("/api/ledger")).status).toBe(501);
  });

  it("mods: search, check then add, a refusal is a 400, remove by a scoped name", async () => {
    const added: string[] = [];
    const removed: string[] = [];
    const { app } = await setup(undefined, {
      mods: {
        list: () => [],
        search: async (q) => [{ name: `autobrowse-mod-${q}` } as never],
        check: async (source) => {
          if (source === "code") throw new Error("code: refused\n  ships code: --trust");
          return { name: source, permissions: ["a@1.0.0: d"], source: `${source}@1.0.0` };
        },
        add: async (source) => {
          added.push(source);
          return "/dir";
        },
        remove: (name) => {
          removed.push(name);
          return name === "@a/b";
        },
      },
    });
    expect(await (await app.request("/api/mods/search?q=scratch")).json()).toEqual([
      { name: "autobrowse-mod-scratch" },
    ]);
    expect(
      (await (await app.request(post("/api/mods/check", { source: "a" }))).json()).source,
    ).toBe("a@1.0.0");
    expect((await app.request(post("/api/mods/check", { source: "code" }))).status).toBe(400);
    expect((await app.request(post("/api/mods", { source: "a@1.0.0" }))).status).toBe(200);
    expect(added).toEqual(["a@1.0.0"]);
    const del = (name: string) =>
      app.request(
        new Request(`http://x/api/mods/${encodeURIComponent(name)}`, { method: "DELETE" }),
      );
    expect((await del("@a/b")).status).toBe(200);
    expect((await del("gone")).status).toBe(404);
    expect(removed).toEqual(["@a/b", "gone"]);
    const bare = await setup();
    expect((await bare.app.request("/api/mods")).status).toBe(501);
  });

  it("lists live workflows with proofs, and proves a compiled one on request", async () => {
    const proof = { at: "2026-09-20T05:00:00Z", status: "done", steps: [], output: null };
    const proved: string[] = [];
    let release: () => void = () => undefined;
    const { app } = await setup(undefined, {
      workflows: async () => [domainWorkflow, { ...domainWorkflow, name: "google-name" }],
      proofs: async () => ({ "google-name": proved.length ? proof : null }),
      prove: async (name) => {
        await new Promise<void>((r) => (release = r));
        proved.push(name);
        return proof;
      },
    });
    const before = await (await app.request("/api/workflows")).json();
    expect(before.map((w: { name: string; proof?: unknown }) => [w.name, w.proof])).toEqual([
      ["domain", undefined],
      ["google-name", null],
    ]);
    expect((await app.request(post("/api/workflows/domain/prove"))).status).toBe(404);
    // Minutes long in life: a job comes back at once; the page polls it.
    const started = await app.request(post("/api/workflows/google-name/prove"));
    expect(started.status).toBe(202);
    const job = await started.json();
    expect(job).toMatchObject({ kind: "prove", key: "google-name", status: "running" });
    // A second click while it runs joins the same job.
    expect((await (await app.request(post("/api/workflows/google-name/prove"))).json()).id).toBe(
      job.id,
    );
    // `wait` holds the answer until it settles: one request instead of a poll loop.
    const waiting = app.request(`/api/jobs/${job.id}?wait=5000`);
    release();
    expect(await (await waiting).json()).toMatchObject({ status: "done", result: proof });
    expect(proved).toEqual(["google-name"]);
    expect((await app.request("/api/jobs/nope")).status).toBe(404);
    const after = await (await app.request("/api/workflows")).json();
    expect(after[1].proof).toEqual(proof);
    const bare = await setup();
    expect((await bare.app.request(post("/api/workflows/google-name/prove"))).status).toBe(501);
  });

  it("reads and saves a compiled workflow's outline, re-rendering it; refuses bad or renamed ones", async () => {
    const outline: Outline = {
      name: "chore",
      site: "scratch",
      description: "d",
      fields: [],
      secrets: [],
      steps: [
        {
          kind: "browser",
          name: "open",
          description: "",
          irreversible: false,
          proof: null,
          url: "https://x.test/a",
          ops: [],
        },
      ],
    };
    const saved: Outline[] = [];
    const { app } = await setup(undefined, {
      outline: {
        load: async (name) => (name === "chore" ? outline : null),
        save: async (_name, o) => {
          saved.push(o);
          return { outline: o, usage: null, files: { "index.ts": "// new" } };
        },
      },
    });
    const put = (path: string, body: unknown) =>
      new Request(`http://x${path}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(await (await app.request("/api/workflows/chore/outline")).json()).toEqual(outline);
    expect((await app.request("/api/workflows/domain/outline")).status).toBe(404);
    expect((await app.request(put("/api/workflows/domain/outline", outline))).status).toBe(404);
    expect((await app.request(put("/api/workflows/chore/outline", { name: "chore" }))).status).toBe(
      400,
    );
    expect(
      (await app.request(put("/api/workflows/chore/outline", { ...outline, name: "other" })))
        .status,
    ).toBe(400);
    const edited = { ...outline, description: "edited" };
    const res = await app.request(put("/api/workflows/chore/outline", edited));
    expect(res.status).toBe(200);
    expect((await res.json()).files["index.ts"]).toBe("// new");
    expect(saved).toEqual([edited]);
    const bare = await setup();
    expect((await bare.app.request(put("/api/workflows/chore/outline", outline))).status).toBe(501);
  });

  it("pages the run list newest first", async () => {
    const { app } = await setup();
    const rows = await (await app.request("/api/runs")).json();
    expect(rows.map((r: RunRow) => r.key)).toEqual(["x.com"]);
    expect(await (await app.request("/api/runs?limit=1&before=t")).json()).toEqual([]);
    const many = Array.from({ length: 5 }, (_, i) => ({
      ...rows[0],
      key: `k${i}`,
      updatedAt: `2026-09-2${i}`,
    }));
    expect(pageOf(many, { limit: 2 }).map((r) => r.key)).toEqual(["k4", "k3"]);
    expect(pageOf(many, { limit: 2, before: "2026-09-23" }).map((r) => r.key)).toEqual([
      "k2",
      "k1",
    ]);
    // An event's row lands in place: moved to the front when it is the newest, replaced when unchanged in order.
    const sorted = pageOf(many, { limit: 5 });
    expect(placeRow(sorted, { ...many[1], updatedAt: "2026-09-29" }).map((r) => r.key)).toEqual([
      "k1",
      "k4",
      "k3",
      "k2",
      "k0",
    ]);
    expect(placeRow(sorted, { ...many[4], status: "done" }).map((r) => r.key)).toEqual([
      "k4",
      "k3",
      "k2",
      "k1",
      "k0",
    ]);
    expect(
      placeRow(sorted, { ...many[0], key: "new", updatedAt: "2026-09-01" }).map((r) => r.key),
    ).toEqual(["k4", "k3", "k2", "k1", "k0", "new"]);
    // Rows updated in the same instant: the cursor carries the id, so the page edge loses none.
    const same = ["a", "b", "c"].map((key) => ({ ...rows[0], key, updatedAt: "2026-09-25" }));
    const first = pageOf(same, { limit: 2 });
    expect(first.map((r) => r.key)).toEqual(["c", "b"]);
    const second = pageOf(same, { limit: 2, before: cursorOf(first[1] as RunRow) });
    expect(second.map((r) => r.key)).toEqual(["a"]);
  });

  it("starts, answers and controls runs through the ingress", async () => {
    const { app, calls } = await setup();
    expect(
      (
        await app.request(
          post("/api/runs/domain/x.com", {
            plan: {
              domain: "x.com",
              inboxes: [{ local: "wi", givenName: "Wi", familyName: "Jin" }],
            },
          }),
        )
      ).status,
    ).toBe(202);
    expect((await app.request(post("/api/runs/domain/x.com", { plan: { nope: 1 } }))).status).toBe(
      400,
    );
    expect((await app.request(post("/api/runs/nope/x.com", { plan: {} }))).status).toBe(404);
    expect((await app.request(post("/api/runs/domain/x.com/approve", { note: "go" }))).status).toBe(
      200,
    );
    expect((await app.request(post("/api/runs/domain/x.com/pause"))).status).toBe(200);
    expect((await app.request(post("/api/runs/domain/x.com/explode"))).status).toBe(404);
    expect(calls).toEqual([expect.stringMatching(/^run .*x\.com/), "approve purchase go", "pause"]);
  });

  it("turns an inbound message into a command on the waiting run", async () => {
    const { app, calls } = await setup();
    const yes = await (
      await app.request(post("/hooks/inbound", { text: "yes looks fine" }))
    ).json();
    expect(yes.reply).toBe("domain/x.com: purchase approved");
    expect(calls).toEqual(["approve purchase looks fine"]);
    const status = await (await app.request(post("/hooks/inbound", { text: "status" }))).json();
    expect(status.reply).toMatch(/waiting at buy/);
    const huh = await (await app.request(post("/hooks/inbound", { text: "what" }))).json();
    expect(huh.reply).toMatch(/say yes, no/);
  });

  it("answers the operator's iMessage through Linq when the signature checks out", async () => {
    const sent: string[] = [];
    const client = {
      send: async (_to: string, text: string) => void sent.push(text),
      recent: async () => [],
      learn: () => undefined,
      reader: () => ({ recent: async () => [] }),
    };
    const secret = `whsec_${Buffer.from("k".repeat(32)).toString("base64")}`;
    const { app, calls } = await setup("tok", { linq: { client, to: "+15550001111", secret } });
    const body = JSON.stringify({
      type: "message.received",
      data: {
        id: "m1",
        chat_id: "c1",
        from: "+15550001111",
        parts: [{ type: "text", value: "yes" }],
      },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = {
      "content-type": "application/json",
      "webhook-id": "e1",
      "webhook-timestamp": ts,
      "webhook-signature": signLinqWebhook("e1", ts, body, secret),
    };
    const ok = await app.request("/hooks/linq", { method: "POST", body, headers });
    expect(ok.status).toBe(200);
    expect(sent).toEqual(["domain/x.com: purchase approved"]);
    expect(calls[0]).toMatch(/^approve purchase/);
    const bad = await app.request("/hooks/linq", {
      method: "POST",
      body,
      headers: { ...headers, "webhook-signature": "v1,AAAA" },
    });
    expect(bad.status).toBe(401);
    const stranger = JSON.stringify({
      type: "message.received",
      data: { id: "m2", from: "+19990000000", parts: [{ type: "text", value: "yes" }] },
    });
    const r = await app.request("/hooks/linq", {
      method: "POST",
      body: stranger,
      headers: { ...headers, "webhook-signature": signLinqWebhook("e1", ts, stranger, secret) },
    });
    expect(await r.json()).toEqual({ ignored: "not the operator" });
    expect(sent).toHaveLength(1);
  });

  it("reads and replaces the live settings; status shows the screen as it is now", async () => {
    const screen = { headless: true };
    const { app } = await setup(undefined, {
      screen,
      status: { llm: "fake", browser: { tier: "local", headless: true }, workflows: [] } as never,
    });
    expect(await (await app.request("/api/settings")).json()).toEqual({ headless: true });
    const put = await app.request(
      new Request("http://x/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ headless: false }),
      }),
    );
    expect(await put.json()).toEqual({ headless: false });
    expect(screen.headless).toBe(false);
    expect((await (await app.request("/api/status")).json()).browser.headless).toBe(false);
    const bad = await app.request(
      new Request("http://x/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ headless: "yes" }),
      }),
    );
    expect(bad.status).toBe(400);
    expect(screen.headless).toBe(false);
  });

  it("finds a waiting run under pages of newer ones", async () => {
    const row = (i: number, status = "done") =>
      ({
        workflow: "domain",
        key: `k${i}`,
        status,
        updatedAt: new Date(1e12 - i * 1000).toISOString(),
      }) as RunRow;
    const all = [...Array(250)].map((_, i) => row(i, i === 230 ? "waiting" : "done"));
    const registry = { list: async (q: ListQuery) => pageOf(all, q) };
    expect((await findRow(registry, (r) => r.status === "waiting"))?.key).toBe("k230");
    expect(await findRow(registry, (r) => r.key === "nope")).toBeUndefined();
    expect(await findRow(registry, (r) => r.key === "k230", 2)).toBeUndefined();
  });

  it("lists accounts without values, saves an edit, and proves a sign-in as a job", async () => {
    const { app } = await setup();
    const rows = await (await app.request("/api/accounts")).json();
    expect(rows).toMatchObject([{ site: "instantly", username: "a", has: { password: true } }]);
    const saved = await app.request(
      new Request("http://x/api/accounts/instantly", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "b", password: "p" }),
      }),
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ site: "instantly", username: "b" });
    const bad = await app.request(
      new Request("http://x/api/accounts/sentry", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ via: "google" }),
      }),
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/password or a via/);
    const notJson = await app.request(
      new Request("http://x/api/accounts/sentry", { method: "PUT", body: "nope" }),
    );
    expect(notJson.status).toBe(415);
    expect(await notJson.json()).toMatchObject({ code: "unsupported_media_type" });
    const broken = await app.request(
      new Request("http://x/api/accounts/sentry", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "nope",
      }),
    );
    expect(await broken.json()).toMatchObject({ code: "invalid_json" });
    const check = await app.request(post("/api/accounts/instantly/check"));
    expect(check.status).toBe(202);
    const job = (await check.json()) as { id: string };
    const done = await (await app.request(`/api/jobs/${job.id}?wait=1000`)).json();
    expect(done).toMatchObject({
      kind: "login",
      key: "instantly",
      status: "done",
      result: "signed in to instantly",
    });
  });

  it("routes a goal: a dry run answers at once, a real one is a job", async () => {
    const { app } = await setup();
    expect(await (await app.request("/api/abilities")).json()).toMatchObject([
      { name: "tube POST /v1/videos", ready: true },
    ]);
    const dry = await app.request(post("/api/do", { goal: "upload", dryRun: true }));
    expect(dry.status).toBe(200);
    expect(await dry.json()).toMatchObject({ status: "planned" });
    const bad = await app.request(post("/api/do", { goal: "" }));
    expect(bad.status).toBe(400);
    const started = await app.request(post("/api/do", { goal: "upload", inputs: { file: "a" } }));
    expect(started.status).toBe(202);
    const job = (await started.json()) as { id: string };
    const done = await (await app.request(`/api/jobs/${job.id}?wait=1000`)).json();
    expect(done).toMatchObject({
      kind: "do",
      key: "upload",
      status: "done",
      result: { via: "site", status: "done", output: { id: "v1" } },
    });
  });

  it("touches on writes, never on reads", async () => {
    let touched = 0;
    const { app } = await setup(undefined, { touch: () => touched++ });
    await app.request(new Request("http://x/api/status"));
    await app.request(new Request("http://x/api/workflows"));
    expect(touched).toBe(0);
    await app.request(post("/api/runs/domain/x.com", { plan: { nope: 1 } }));
    expect(touched).toBe(1);
  });

  it("requires the bearer when one is set", async () => {
    const { app } = await setup("s3cret");
    expect((await app.request("/api/runs")).status).toBe(401);
    expect(
      (await app.request("/api/runs", { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    expect(
      (await app.request("/api/runs", { headers: { authorization: "Bearer s3cret" } })).status,
    ).toBe(200);
  });

  it("serves recordings, their files (inside the dir only) and compiles them", async () => {
    const { app } = await setup();
    // The list is rows, not manifests: counts stand in for the actions.
    expect(await (await app.request("/api/recordings")).json()).toEqual([
      expect.objectContaining({ name: "chore", actionCount: expect.any(Number) }),
    ]);
    expect((await (await app.request("/api/recordings")).json())[0].actions).toBeUndefined();
    expect((await app.request("/api/recordings/chore/files/shot.png")).status).toBe(200);
    expect((await app.request("/api/recordings/chore/files/../../x")).status).toBe(404);
    expect((await app.request("/api/recordings/Bad/files/x")).status).toBe(400);
    const compiled = await (await app.request(post("/api/recordings/chore/compile"))).json();
    expect(compiled.files["index.ts"]).toBe("//");
  });

  it("streams recent and live events", async () => {
    const { app, bus } = await setup();
    await bus.deliver({ type: "started", run: { workflow: "domain", key: "x.com" }, at: "t" });
    const res = await app.request("/api/events");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("event: started");
    await bus.deliver({ type: "paused", run: { workflow: "domain", key: "x.com" }, at: "t" });
    const second = new TextDecoder().decode((await reader.read()).value);
    expect(second).toContain("event: paused");
    await reader.cancel();
  });
});

describe("api conventions", () => {
  const many = (n: number) => {
    const base = fakeIngress().ingress;
    const all = [...Array(n)].map(
      (_, i) =>
        ({
          workflow: i % 2 ? "domain" : "chore",
          key: `k${i}`,
          startedAt: "t",
          status: i % 3 ? "done" : "waiting",
          updatedAt: new Date(1e12 + i * 1000).toISOString(),
        }) as RunRow,
    );
    const asked: ListQuery[] = [];
    const ingress = {
      ...base,
      run: base.run,
      registry: () => ({
        list: async (q: ListQuery) => {
          asked.push(q);
          return pageOf(all, q);
        },
      }),
    } as unknown as Ingress;
    return { ingress, asked };
  };

  it("filters runs in the registry and links the next page", async () => {
    const { ingress, asked } = many(30);
    const { app } = await setup(undefined, { ingress });
    const first = await app.request("/api/runs?status=waiting&limit=4");
    const rows = (await first.json()) as RunRow[];
    expect(rows.map((r) => r.key)).toEqual(["k27", "k24", "k21", "k18"]);
    expect(asked.at(-1)).toMatchObject({ status: ["waiting"], limit: 5 });
    const link = first.headers.get("link") ?? "";
    expect(link).toMatch(/rel="next"/);
    const next = link.slice(1, link.indexOf(">"));
    const rest = (await (await app.request(next)).json()) as RunRow[];
    expect(rest.map((r) => r.key)).toEqual(["k15", "k12", "k9", "k6"]);
    const tail = await app.request("/api/runs?status=waiting&limit=50");
    expect(tail.headers.get("link")).toBeNull();
    expect(((await tail.json()) as RunRow[]).length).toBe(10);
    const chores = (await (
      await app.request("/api/runs?workflow=chore&status=done,waiting&limit=3")
    ).json()) as RunRow[];
    expect(chores.every((r) => r.workflow === "chore")).toBe(true);
  });

  it("refuses a bad query, path or body with a code and the field", async () => {
    const { app } = await setup();
    const bad = await app.request("/api/runs?limit=0");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      code: "invalid_query",
      error: expect.stringMatching(/^limit:/),
      issues: [{ path: "limit" }],
    });
    expect(await (await app.request("/api/runs?status=sleeping")).json()).toMatchObject({
      code: "invalid_query",
    });
    expect((await app.request("/api/jobs?limit=500")).status).toBe(400);
    expect((await app.request("/api/jobs/x?wait=-1")).status).toBe(400);
    expect(
      await (await app.request("/api/accounts/Bad%20Site/check", { method: "POST" })).json(),
    ).toMatchObject({ code: "invalid_path" });
    const noPlan = await app.request(post("/api/runs/domain/x.com", { plan: { domain: 1 } }));
    expect(await noPlan.json()).toMatchObject({
      code: "invalid_body",
      issues: [expect.objectContaining({ path: "plan.domain" })],
    });
  });

  it("answers an unknown route as JSON, a big body 413, a thrown handler 500 without a stack", async () => {
    const { app } = await setup(undefined, {
      limits: { bodyBytes: 100 },
      accounts: {
        ...fakeAccounts,
        list: async () => {
          throw new Error("secret detail");
        },
      },
    });
    const missing = await app.request("/api/nope");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "not_found" });
    const big = await app.request(post("/api/do", { goal: "x".repeat(200) }));
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ code: "payload_too_large" });
    const thrown = await app.request("/api/accounts");
    expect(thrown.status).toBe(500);
    const body = await thrown.json();
    expect(body.code).toBe("internal");
    expect(JSON.stringify(body)).not.toMatch(/secret detail/);
  });

  it("rate limits per caller, with the standard headers", async () => {
    const { app } = await setup(undefined, { limits: { reads: 2, writes: 1 } });
    const one = await app.request("/api/workflows");
    expect(one.headers.get("ratelimit-limit")).toBe("2");
    expect(one.headers.get("ratelimit-remaining")).toBe("1");
    await app.request("/api/workflows");
    const over = await app.request("/api/workflows");
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await over.json()).toMatchObject({ code: "rate_limited" });
    // Writes count apart from reads.
    expect((await app.request(post("/api/do", { goal: "g", dryRun: true }))).status).toBe(200);
    expect((await app.request(post("/api/do", { goal: "g", dryRun: true }))).status).toBe(429);
  });

  it("points a started job and run at where to read them", async () => {
    const { app } = await setup();
    const job = await app.request(post("/api/accounts/instantly/check"));
    expect(job.headers.get("location")).toBe(
      `/api/jobs/${((await job.json()) as { id: string }).id}`,
    );
    const run = await app.request(post("/api/runs/domain/x.com", { plan: { domain: "x.com" } }));
    expect(run.status).toBe(202);
    expect(run.headers.get("location")).toBe("/api/runs/domain/x.com");
  });
});

describe("api: agent sessions", () => {
  function fakeAgent() {
    const views = new Map<string, SessionView>();
    const calls: string[] = [];
    const agent: AgentSessions = {
      async flush() {},
      async start(req) {
        const v: SessionView = {
          id: "abc",
          site: req.site,
          goal: req.goal,
          inputs: req.inputs ?? {},
          status: "running",
          prompt: null,
          steps: [],
          achieved: null,
          summary: null,
          error: null,
          recording: null,
          recordingName: null,
          usage: { inputTokens: 0, outputTokens: 0 },
          startedAt: "2026-09-20T00:00:00.000Z",
          port: 9100,
        };
        views.set(v.id, v);
        return v;
      },
      list: () => [...views.values()],
      get: (id) => views.get(id) ?? null,
      async pause(id) {
        calls.push(`pause ${id}`);
        return views.get(id) as SessionView;
      },
      async resume(id) {
        calls.push(`resume ${id}`);
        return views.get(id) as SessionView;
      },
      async stop(id) {
        calls.push(`stop ${id}`);
        return views.get(id) as SessionView;
      },
      async save(id, name) {
        calls.push(`save ${id} ${name}`);
        return views.get(id) as SessionView;
      },
      async close(id) {
        calls.push(`close ${id}`);
        return views.get(id) as SessionView;
      },
      async exec(id, command) {
        calls.push(`exec ${id} ${command.cmd}`);
        return { ok: true };
      },
    };
    return { agent, calls };
  }
  it("starts, reads, controls and saves a session; validates the body", async () => {
    const { app } = await setup();
    const { agent, calls } = fakeAgent();
    const withAgent = api({
      workflows: [],
      ingress: fakeIngress().ingress,
      bus: eventBus(),
      recordingsDir: "/nowhere",
      artifactsDir: "/nowhere",
      compile: async () => ({ outline: {} as never, usage: null, files: {} }),
      token: undefined,
      agent,
    });
    expect((await app.request(post("/api/agent", { site: "google", goal: "g" }))).status).toBe(501);
    const bad = await withAgent.request(post("/api/agent", { site: "Bad Site", goal: "g" }));
    expect(bad.status).toBe(400);
    const started = await withAgent.request(
      post("/api/agent", { site: "google@ops", goal: "find the name", maxSteps: 5 }),
    );
    expect(started.status).toBe(201);
    expect(await started.json()).toMatchObject({ id: "abc", site: "google@ops" });
    const listed = await (await withAgent.request("/api/agent")).json();
    expect(listed).toEqual([expect.objectContaining({ id: "abc", stepCount: expect.any(Number) })]);
    expect(listed[0].steps).toBeUndefined();
    expect((await withAgent.request("/api/agent/abc")).status).toBe(200);
    expect((await withAgent.request("/api/agent/nope")).status).toBe(404);
    for (const a of ["pause", "resume", "stop"])
      expect((await withAgent.request(post(`/api/agent/abc/${a}`, {}))).status).toBe(200);
    expect((await withAgent.request(post("/api/agent/abc/save", {}))).status).toBe(200);
    expect(
      (await withAgent.request(post("/api/agent/abc/save", { name: "Bad Name" }))).status,
    ).toBe(400);
    expect((await withAgent.request(post("/api/agent/abc/dance", {}))).status).toBe(404);
    expect(
      (await withAgent.request(post("/api/agent/abc/exec", { cmd: "note", text: "x" }))).status,
    ).toBe(200);
    expect((await withAgent.request(post("/api/agent/abc/exec", { cmd: "dance" }))).status).toBe(
      400,
    );
    expect(calls).toEqual([
      "pause abc",
      "resume abc",
      "stop abc",
      "save abc find-the-name",
      "exec abc note",
    ]);
  });

  it("serves site apis under the official path, merging query and body, and setup as a job", async () => {
    const calls: unknown[] = [];
    const sites: SiteFacade = {
      list: async () => [{ site: "linkedin", origin: "o", authed: false, routes: [], setup: [] }],
      status: async (site) => {
        if (site !== "linkedin") throw new SiteError(404, "no site");
        return {
          site,
          origin: "o",
          authed: false,
          routes: [],
          setup: [
            { name: "developer-app", makes: ["A"], summary: "", done: false, blockedOn: [] },
            {
              name: "consent",
              makes: ["B"],
              needs: ["A"],
              summary: "",
              done: false,
              blockedOn: ["A"],
            },
          ],
        };
      },
      call: async (site, method, path, input) => {
        calls.push([site, method, path, input]);
        if (path === "/rest/posts" && method === "POST" && !("author" in input))
          throw new SiteError(400, "author: a LinkedIn URN");
        return { id: "urn:li:share:1" };
      },
      setup: async (_site, step) => ({ made: [step] }),
    };
    const { app } = await setup(undefined, { sites });
    expect(await (await app.request("/api/sites")).json()).toEqual([
      expect.objectContaining({ site: "linkedin" }),
    ]);
    expect((await app.request("/api/sites/nope")).status).toBe(404);
    const ok = await app.request(
      post("/api/sites/linkedin/rest/posts?x=1", { author: "urn:li:person:a", commentary: "hi" }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: "urn:li:share:1" });
    expect(calls[0]).toEqual([
      "linkedin",
      "POST",
      "/rest/posts",
      { x: "1", author: "urn:li:person:a", commentary: "hi" },
    ]);
    const bad = await app.request(post("/api/sites/linkedin/rest/posts", { commentary: "hi" }));
    expect(bad.status).toBe(400);
    const get = await app.request(
      "/api/sites/linkedin/rest/socialActions/urn:li:share:1/comments?count=3",
    );
    expect(get.status).toBe(200);
    expect(calls[2]).toEqual([
      "linkedin",
      "GET",
      "/rest/socialActions/urn:li:share:1/comments",
      { count: "3" },
    ]);
    expect((await app.request(post("/api/sites/linkedin/setup/consent"))).status).toBe(409);
    expect((await app.request(post("/api/sites/linkedin/setup/nope"))).status).toBe(404);
    const job = await app.request(post("/api/sites/linkedin/setup/developer-app"));
    expect(job.status).toBe(202);
    const { id } = (await job.json()) as { id: string };
    expect(await (await app.request(`/api/jobs/${id}?wait=1000`)).json()).toMatchObject({
      status: "done",
      result: { made: ["developer-app"] },
    });
    const bare = await setup();
    expect((await bare.app.request("/api/sites")).status).toBe(501);
  });
});

describe("send gate", () => {
  it("a step's send gate waits, then one approve runs the step once", async () => {
    const { memoryEffects, runFlow, defineWorkflow, done } = await import("../src/index.js");
    let sent = 0;
    const wf = defineWorkflow<Record<string, never>, Record<string, never>>()({
      name: "send-test",
      description: "",
      plan: z.object({ dryRun: z.boolean().default(false) }),
      steps: [
        {
          name: "send",
          irreversible: true,
          async run({ gate }) {
            const a = gate("send", "send it?");
            if (!a.approved) return done("not sent");
            sent++;
            return done("sent");
          },
        },
      ],
      emptyMemo: () => ({}),
    });
    const { fx } = memoryEffects();
    expect((await runFlow(fx, wf, {}, { dryRun: false })).status).toBe("waiting");
    expect(sent).toBe(0);
    const out = await runFlow(fx, wf, {}, { dryRun: false }, (g) => ({
      approved: g.name === "send",
      note: null,
      at: "now",
    }));
    expect(out.status).toBe("done");
    expect(sent).toBe(1);
  });
});

describe("api with agent keys", () => {
  it("a key sees and calls only its scope; a wrong key is 401; the owner sees all", async () => {
    const { fileKeys } = await import("../src/access/keys.js");
    const keys = fileKeys(join(await mkdtemp(join(tmpdir(), "keys-")), "agent-keys.json"));
    const agent = keys.add("helper", {
      sites: ["tube"],
      workflows: [],
      tools: [],
      can: ["do"],
    }).key;
    const outsider = keys.add("outsider", { sites: [], workflows: [], tools: [], can: [] }).key;
    const { app } = await setup("owner-token", {
      keys,
      doAs: (scope) => ({
        do: async () => {
          throw new Error(`not in this test: ${scope.name}`);
        },
        abilities: async () => [],
      }),
    });
    const as = (key: string) => ({ authorization: `Bearer ${key}` });
    expect((await app.request("/api/status", { headers: as("abk_nope_x") })).status).toBe(401);
    expect((await app.request("/api/accounts", { headers: as(agent) })).status).toBe(403);
    expect((await app.request("/api/accounts", { headers: as("owner-token") })).status).toBe(200);
    // Lists cut to scope: no workflow granted, so no domain runs.
    const runs = await (await app.request("/api/runs", { headers: as(agent) })).json();
    expect(JSON.stringify(runs)).not.toContain("domain");
    expect((await app.request(post("/api/runs/domain/k1/approve", {}, as(agent)))).status).toBe(
      403,
    );
    // The site in the body is checked.
    expect(
      (await app.request(post("/api/do", { goal: "x", site: "google" }, as(agent)))).status,
    ).toBe(403);
    expect((await app.request(post("/api/do", { goal: "upload" }, as(outsider)))).status).toBe(403);
    const job = await (await app.request(post("/api/do", { goal: "upload" }, as(agent)))).json();
    expect(job.by).toBe("helper");
    const theirs = await (await app.request("/api/jobs", { headers: as(outsider) })).json();
    expect(JSON.stringify(theirs)).not.toContain("helper");
    const owners = await (await app.request("/api/jobs", { headers: as("owner-token") })).json();
    expect(JSON.stringify(owners)).toContain("helper");
  });
});

describe("api from a web page", () => {
  it("refuses a foreign origin and, without a token, a non-loopback host", async () => {
    const { app } = await setup();
    const at = (headers: Record<string, string>) => app.request("/api/status", { headers });
    expect((await at({ host: "127.0.0.1:9080" })).status).toBe(200);
    expect((await at({ host: "127.0.0.1:9080", origin: "http://localhost:5173" })).status).toBe(
      200,
    );
    expect((await at({ host: "127.0.0.1:9080", origin: "https://evil.example" })).status).toBe(403);
    // DNS rebinding: evil.example resolves to 127.0.0.1, so origin and host agree.
    expect(
      (await at({ host: "evil.example:9080", origin: "http://evil.example:9080" })).status,
    ).toBe(403);
    const withToken = (await setup("t")).app;
    expect(
      (
        await withToken.request("/api/status", {
          headers: { host: "box.internal:9080", authorization: "Bearer t" },
        })
      ).status,
    ).toBe(200);
  });
});
