import { describe, expect, it } from "vitest";
import { type Repairer, rememberingRepairer } from "../src/browser/repair.js";
import { memoryChannel } from "../src/channels/memory.js";
import { httpClient } from "../src/clients/http.js";
import { backboardMemory } from "../src/memory/backboard.js";
import { memoryStore } from "../src/memory/types.js";

describe("memoryStore", () => {
  it("recalls by word overlap, best first", async () => {
    const m = memoryStore();
    await m.remember("site=cloudflare goal=click Purchase hints={}");
    await m.remember("site=google goal=click Next");
    const hits = await m.recall("cloudflare click Purchase");
    expect(hits[0]?.content).toMatch(/cloudflare/);
    expect(await m.recall("zzz")).toEqual([]);
  });
});

describe("rememberingRepairer", () => {
  it("offers a remembered fix before asking the model, and learns from successes", async () => {
    const memory = memoryStore();
    let asked = 0;
    const model: Repairer = {
      id: "m",
      propose: async () => {
        asked++;
        return { hints: { role: "button", name: "Buy" }, reason: "model" };
      },
    };
    const r = rememberingRepairer(memory, model);
    const req = {
      site: "cf",
      goal: "click Purchase",
      failed: { name: "Purchase" },
      url: "u",
      snapshot: "",
    };
    const first = await r.propose(req);
    expect(first?.reason).toBe("model");
    expect(asked).toBe(1);
    if (!first) throw new Error("no proposal");
    await r.learn({ ...req, ...first, flow: "cf/buy", ok: true });
    const second = await r.propose(req);
    expect(second?.hints).toEqual({ role: "button", name: "Buy" });
    expect(second?.reason).toMatch(/^remembered/);
    expect(asked).toBe(1);
    // A failed repair is not remembered.
    await r.learn({ ...req, hints: { id: "x" }, reason: "no", flow: "cf/buy", ok: false });
    expect(memory.items).toHaveLength(1);
  });
});

describe("memoryChannel", () => {
  it("remembers hand-off notes and needs-human steps only", async () => {
    const memory = memoryStore();
    const ch = memoryChannel(memory);
    const run = { workflow: "domain", key: "x.com" };
    await ch.deliver({
      type: "gate-answered",
      run,
      at: "t",
      gate: "human",
      step: "buy",
      approved: true,
      note: "did 2FA by hand",
    });
    await ch.deliver({
      type: "gate-answered",
      run,
      at: "t",
      gate: "purchase",
      step: "buy",
      approved: true,
      note: null,
    });
    await ch.deliver({
      type: "step",
      run,
      at: "t",
      step: "buy",
      result: { status: "needs-human", detail: "captcha", at: "t" },
    });
    await ch.deliver({
      type: "step",
      run,
      at: "t",
      step: "zone",
      result: { status: "done", detail: "ok", at: "t" },
    });
    expect(memory.items.map((m) => m.meta.kind)).toEqual(["hand-off", "needs-human"]);
    expect(memory.items[0]?.content).toContain("did 2FA by hand");
  });
});

describe("backboardMemory", () => {
  it("finds or creates its assistant once, then adds and searches under it", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url: u, method, body });
      const json = (v: unknown) =>
        new Response(JSON.stringify(v), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (u.endsWith("/assistants") && method === "GET") return json([]);
      if (u.endsWith("/assistants") && method === "POST")
        return json({ assistant_id: "A1", name: body.name });
      if (u.endsWith("/A1/memories") && method === "POST") return json({ id: "M1" });
      if (u.endsWith("/A1/memories/search"))
        return json({ memories: [{ id: "M1", content: "hello", score: 0.9 }] });
      return new Response("nope", { status: 404 });
    };
    const m = backboardMemory({
      apiKey: "sekret-key-123",
      http: httpClient({ fetch }),
      assistant: "t",
    });
    expect(await m.remember("hello", { kind: "x" })).toBe("M1");
    expect(await m.recall("hi")).toEqual([{ id: "M1", content: "hello", score: 0.9 }]);
    expect(calls.map((c) => `${c.method} ${c.url.split("/api")[1]}`)).toEqual([
      "GET /assistants",
      "POST /assistants",
      "POST /assistants/A1/memories",
      "POST /assistants/A1/memories/search",
    ]);
    expect(calls.every((c) => !c.url.includes("sekret-key-123"))).toBe(true);
  });
});
