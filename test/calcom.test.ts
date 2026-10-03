import { describe, expect, it } from "vitest";
import { httpClient } from "../src/clients/http.js";
import { calcom } from "../src/sites/calcom.js";
import type { ApiLeg } from "../src/sites/types.js";
import { fakeFetch } from "./fakes.js";

const routeOf = (method: string, path: string) => {
  const r = calcom.routes.find((x) => x.method === method && x.path === path);
  if (!r?.api) throw new Error(`no route ${method} ${path}`);
  return r as unknown as {
    request: { parse: (i: unknown) => unknown };
    api: (i: unknown, leg: ApiLeg) => Promise<unknown>;
  };
};

describe("calcom webhooks", () => {
  it("signs a new booking webhook with a secret it keeps and never returns", async () => {
    const f = fakeFetch(({ body }) => ({
      status: 201,
      body: { status: "success", data: { id: 7, ...JSON.parse(body ?? "{}") } },
    }));
    const kept = new Map<string, string>();
    const leg: ApiLeg = {
      token: "cal_key",
      http: httpClient({ fetch: f.fetch }),
      env: () => undefined,
      keep: async (n, v) => {
        kept.set(n, v);
      },
    };
    const r = routeOf("POST", "/v2/webhooks");
    const out = await r.api(
      r.request.parse({
        subscriberUrl: "https://x.test/api/calcom",
        keep: "CALCOM_WEBHOOK_SECRET",
      }),
      leg,
    );
    const secret = kept.get("CALCOM_WEBHOOK_SECRET") ?? "";
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(out)).not.toContain(secret);
    const sent = JSON.parse(f.calls[0]?.body ?? "{}");
    expect(sent).toMatchObject({
      active: true,
      secret,
      triggers: ["BOOKING_CREATED", "BOOKING_RESCHEDULED", "BOOKING_CANCELLED"],
    });
    expect(f.calls[0]?.headers.get("authorization")).toBe("Bearer cal_key");
  });

  it("lists webhooks without their secrets", async () => {
    const f = fakeFetch(() => ({
      body: { data: [{ id: 1, subscriberUrl: "u", triggers: [], active: true, secret: "s3cr3t" }] },
    }));
    const leg: ApiLeg = { token: "k", http: httpClient({ fetch: f.fetch }), env: () => undefined };
    const out = await routeOf("GET", "/v2/webhooks").api({}, leg);
    expect(JSON.stringify(out)).not.toContain("s3cr3t");
  });
});
