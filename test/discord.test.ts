import { describe, expect, it } from "vitest";
import { httpClient } from "../src/clients/http.js";
import { BOT_PERMISSIONS, discord, inviteUrl } from "../src/sites/discord.js";
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

  it("invites with channels, roles and webhooks, never admin", () => {
    const p = BigInt(BOT_PERMISSIONS);
    expect(p & 8n).toBe(0n);
    expect(p & (1n << 29n)).not.toBe(0n);
    expect(inviteUrl("123456", "777777")).toContain("guild_id=777777");
  });
});
