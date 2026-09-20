import { describe, expect, it } from "vitest";
import { httpClient } from "../src/clients/http.js";
import { linqClient, signLinqWebhook, verifyLinqWebhook } from "../src/clients/linq.js";

function fakeLinq() {
  const seen: Array<{ url: string; method: string; auth: string | null; body: unknown }> = [];
  const http = httpClient({
    fetch: async (url, init) => {
      const method = init?.method ?? "GET";
      seen.push({
        url,
        method,
        auth: new Headers(init?.headers).get("authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const json = (b: unknown) =>
        new Response(JSON.stringify(b), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.endsWith("/v3/chats")) return json({ chat_id: "c9", created_new_chat: true });
      if (url.endsWith("/messages") && method === "GET")
        return json({
          messages: [
            {
              id: 1,
              from: "+15550001111",
              parts: [{ type: "text", value: "code 123456" }],
              created_at: "2026-09-19T12:00:00Z",
            },
            {
              id: 2,
              from: "+15550009999",
              parts: [{ type: "text", value: "ours" }],
              created_at: "2026-09-19T12:01:00Z",
            },
            {
              id: 3,
              from: "+15550001111",
              parts: [{ type: "text", value: "old" }],
              created_at: "2026-09-18T12:00:00Z",
            },
          ],
        });
      return json({});
    },
  });
  return { http, seen };
}

describe("linqClient", () => {
  it("creates the chat once, then posts to it; key in the header; reads the operator's messages", async () => {
    const { http, seen } = fakeLinq();
    const c = linqClient({ apiKey: "k-secret", from: "+15550009999", http });
    await c.send("+15550001111", "hello");
    await c.send("+15550001111", "again");
    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      "POST /v3/chats",
      "POST /v3/chats/c9/messages",
    ]);
    expect(seen[0]?.body).toEqual({
      from: "+15550009999",
      to: ["+15550001111"],
      message: { parts: [{ type: "text", value: "hello" }] },
    });
    expect(seen.every((s) => s.auth === "Bearer k-secret" && !s.url.includes("k-secret"))).toBe(
      true,
    );
    const recent = await c.recent("+15550001111", new Date("2026-09-19T00:00:00Z"));
    expect(recent.map((m) => m.text)).toEqual(["code 123456"]);
    expect(await c.recent("+10000000000", new Date(0))).toEqual([]);
  });
  it("reuses a chat learned from an inbound event", async () => {
    const { http, seen } = fakeLinq();
    const c = linqClient({ apiKey: "k", from: "+15550009999", http });
    c.learn("+15550001111", "c1");
    await c.send("+15550001111", "hi");
    expect(new URL(seen[0]?.url ?? "").pathname).toBe("/v3/chats/c1/messages");
  });
});

describe("verifyLinqWebhook", () => {
  const secret = `whsec_${Buffer.from("s".repeat(32)).toString("base64")}`;
  const now = () => 1_800_000_000_000;
  const ts = "1800000000";
  it("accepts a fresh, correctly signed body and nothing else", () => {
    const body = '{"type":"message.received"}';
    const sig = signLinqWebhook("id1", ts, body, secret);
    const h = { "webhook-id": "id1", "webhook-timestamp": ts, "webhook-signature": sig };
    expect(verifyLinqWebhook(h, body, secret, now)).toBe(true);
    expect(verifyLinqWebhook(h, `${body} `, secret, now)).toBe(false);
    expect(verifyLinqWebhook({ ...h, "webhook-signature": `v2,x ${sig}` }, body, secret, now)).toBe(
      true,
    );
    expect(verifyLinqWebhook(h, body, "whsec_other", now)).toBe(false);
    expect(verifyLinqWebhook(h, body, secret, () => now() + 601_000)).toBe(false);
    expect(verifyLinqWebhook({ ...h, "webhook-id": undefined }, body, secret, now)).toBe(false);
  });
});
