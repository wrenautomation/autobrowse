import { describe, expect, it } from "vitest";
import { httpClient } from "../src/clients/http.js";
import {
  applyLayout,
  BOT_PERMISSIONS,
  discord,
  imageData,
  inviteUrl,
  WREN_LAYOUT,
} from "../src/sites/discord.js";
import type { ApiLeg } from "../src/sites/types.js";
import { fakeFetch } from "./fakes.js";

const routeOf = (method: string, path: string) => {
  const r = discord.routes.find((x) => x.method === method && x.path === path);
  if (!r?.api) throw new Error(`no route ${method} ${path}`);
  return r as unknown as {
    request: { parse: (i: unknown) => unknown };
    api: (i: unknown, leg: ApiLeg) => Promise<unknown>;
  };
};

function leg(answer: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(answer);
  const kept = new Map<string, string>();
  const l: ApiLeg = {
    token: "bot-token",
    http: httpClient({ fetch: f.fetch }),
    env: () => undefined,
    keep: async (n, v) => {
      kept.set(n, v);
    },
  };
  return { leg: l, calls: f.calls, kept };
}

describe("discord site", () => {
  it("keeps a new webhook's URL in the sink and never returns it", async () => {
    const url = "https://discord.com/api/webhooks/111/secret-part";
    const t = leg(() => ({
      body: { id: "111", name: "intake", channel_id: "22222", token: "secret-part", url },
    }));
    const r = routeOf("POST", "/channels/{channel}/webhooks");
    const out = await r.api(
      r.request.parse({ channel: "22222", name: "intake", keep: "LANDER_DISCORD_WEBHOOK" }),
      t.leg,
    );
    expect(out).toEqual({
      id: "111",
      name: "intake",
      channel_id: "22222",
      kept: "LANDER_DISCORD_WEBHOOK",
    });
    expect(JSON.stringify(out)).not.toContain("secret-part");
    expect(t.kept.get("LANDER_DISCORD_WEBHOOK")).toBe(url);
    expect(t.calls[0]?.headers.get("authorization")).toBe("Bot bot-token");
    expect(JSON.parse(t.calls[0]?.body ?? "{}")).toEqual({ name: "intake" });
  });

  it("lists webhooks without their tokens", async () => {
    const t = leg(() => ({
      body: [{ id: "1", name: "a", channel_id: "33333", token: "tok", url: "https://x/tok" }],
    }));
    const out = await routeOf("GET", "/guilds/{guild}/webhooks").api({ guild: "44444" }, t.leg);
    expect(JSON.stringify(out)).not.toContain("tok");
  });

  it("makes a channel by type name", async () => {
    const t = leg(() => ({ body: { id: "9" } }));
    const r = routeOf("POST", "/guilds/{guild}/channels");
    await r.api(
      r.request.parse({ guild: "44444", name: "sms", type: "text", parent_id: "55555" }),
      t.leg,
    );
    expect(t.calls[0]?.url.pathname).toBe("/api/v10/guilds/44444/channels");
    expect(JSON.parse(t.calls[0]?.body ?? "{}")).toEqual({
      name: "sms",
      type: 0,
      parent_id: "55555",
    });
  });

  it("sets the server to ping only on @mentions", async () => {
    const t = leg(() => ({
      body: { id: "44444", name: "w", icon: null, default_message_notifications: 1 },
    }));
    const r = routeOf("PATCH", "/guilds/{guild}");
    const out = await r.api(r.request.parse({ guild: "44444", notifications: "mentions" }), t.leg);
    expect(JSON.parse(t.calls[0]?.body ?? "{}")).toEqual({ default_message_notifications: 1 });
    expect(out).toMatchObject({ notifications: "mentions" });
  });

  it("invites with channels, roles and webhooks, never admin", () => {
    const p = BigInt(BOT_PERMISSIONS);
    expect(p & 8n).toBe(0n);
    expect(p & (1n << 29n)).not.toBe(0n);
    expect(inviteUrl("123456", "777777")).toContain("guild_id=777777");
  });

  it("lays a server out by lane, then a second run only re-keeps the URLs", async () => {
    // A tiny Discord: channels and webhooks in memory.
    const chans: {
      id: string;
      name: string;
      type: number;
      parent_id?: string | null;
      topic?: string | null;
    }[] = [
      { id: "10001", name: "general", type: 0, parent_id: null },
      { id: "10002", name: "sms", type: 0, parent_id: null },
    ];
    const hooks: { id: string; name: string; channel_id: string; token: string }[] = [];
    let n = 20000;
    const t = leg(({ method, url, body }) => {
      const path = url.pathname.replace("/api/v10", "");
      const b = body ? JSON.parse(body) : {};
      if (method === "GET" && path.endsWith("/channels")) return { body: chans };
      if (method === "POST" && path.endsWith("/channels")) {
        const c = { id: String(n++), ...b };
        chans.push(c);
        return { body: c };
      }
      const hook = path.match(/^\/channels\/(\d+)\/webhooks$/);
      if (hook && method === "GET") return { body: hooks.filter((h) => h.channel_id === hook[1]) };
      if (hook && method === "POST") {
        const h = { id: String(n++), name: b.name, channel_id: hook[1] ?? "", token: `tok${n}` };
        hooks.push(h);
        return { body: h };
      }
      const patch = path.match(/^\/channels\/(\d+)$/);
      if (patch && method === "PATCH") {
        const c = chans.find((x) => x.id === patch[1]);
        Object.assign(c ?? {}, b);
        return { body: c };
      }
      return { status: 404, body: { message: "no" } };
    });
    const first = await applyLayout(t.leg, "44444", WREN_LAYOUT);
    const sms = first.channels.find((c) => c.channel === "sms");
    expect(sms?.did).toEqual(["moved", "topic", "webhook"]);
    expect(first.channels.find((c) => c.channel === "intake")?.did).toEqual(["made", "webhook"]);
    expect(first.untouched).toEqual(["general"]);
    expect(t.kept.get("WREN_DISCORD_SMS_WEBHOOK_URL")).toMatch(
      /^https:\/\/discord\.com\/api\/webhooks\/\d+\/tok/,
    );
    expect(JSON.stringify(first)).not.toContain("tok");
    const made = chans.length;
    const again = await applyLayout(t.leg, "44444", WREN_LAYOUT);
    expect(again.channels.every((c) => c.did.length === 0)).toBe(true);
    expect(chans.length).toBe(made);
    expect(hooks.length).toBe(WREN_LAYOUT.flatMap((g) => g.channels).length);
  });

  it("turns an image into a data URI and refuses other files", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const f = async () => new Response(png);
    expect(await imageData("https://x.test/pfp.png?sig=1", f as typeof fetch)).toBe(
      `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
    );
    await expect(imageData("notes.txt")).rejects.toThrow(/not png/);
  });
});
