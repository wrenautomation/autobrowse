import { describe, expect, it } from "vitest";
import { cloudflare } from "../src/clients/cloudflare.js";
import { httpClient } from "../src/clients/http.js";
import { digitSwaps, domainIdeas } from "../src/workflows/domain/ideas.js";

/** A tiny Cloudflare: one zone, records in memory, the envelope shape of the real API. */
function fakeApi() {
  const records: Array<{
    id: string;
    type: string;
    name: string;
    content: string;
    priority?: number;
    ttl: number;
  }> = [];
  const calls: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u.pathname}${u.search}`);
    const ok = (result: unknown, status = 200) =>
      new Response(JSON.stringify({ success: true, result, errors: [] }), { status });
    if (u.pathname === "/client/v4/zones" && method === "GET")
      return ok([{ id: "z1", name: "x.test" }]);
    if (u.pathname === "/client/v4/zones/z1" && method === "GET")
      return ok({ id: "z1", name: "x.test" });
    if (u.pathname === "/client/v4/zones/z1/dns_records" && method === "GET") {
      const type = u.searchParams.get("type");
      const name = u.searchParams.get("name");
      return ok(records.filter((r) => (!type || r.type === type) && (!name || r.name === name)));
    }
    if (u.pathname === "/client/v4/zones/z1/dns_records" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as {
        type: string;
        name: string;
        content: string;
        priority?: number;
        ttl: number;
      };
      records.push({ id: `r${records.length + 1}`, ...body });
      return ok(records.at(-1));
    }
    const put = /^\/client\/v4\/zones\/z1\/dns_records\/(r\d+)$/.exec(u.pathname);
    if (put && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { content: string };
      const r = records.find((x) => x.id === put[1]);
      if (r) r.content = body.content;
      return ok(r);
    }
    if (u.pathname === "/client/v4/accounts/acc/registrar/domain-check" && method === "POST") {
      const { domains } = JSON.parse(String(init?.body)) as { domains: string[] };
      return ok({
        domains: domains.map((name) =>
          name.startsWith("taken")
            ? { name, registrable: false, reason: "domain_unavailable", tier: "standard" }
            : {
                name,
                registrable: true,
                tier: "standard",
                pricing: { currency: "USD", registration_cost: "8.50", renewal_cost: "11.20" },
              },
        ),
      });
    }
    if (u.pathname.startsWith("/client/v4/accounts/acc/registrar/domains/")) {
      // As the real API: 200 for any name; only ours carries cloudflare_registration.
      const name = decodeURIComponent(u.pathname.split("/").at(-1) as string);
      return new Response(
        JSON.stringify({
          success: true,
          result:
            name === "ours.test"
              ? { name, cloudflare_registration: true, expires_at: "2027-01-01T00:00:00Z" }
              : { name, supported_tld: true },
          errors: [],
        }),
      );
    }
    return new Response(
      JSON.stringify({
        success: false,
        result: null,
        errors: [{ code: 1, message: `no route ${method} ${u.pathname}` }],
      }),
      { status: 500 },
    );
  };
  return { records, calls, fetchImpl };
}

describe("cloudflare client", () => {
  it("upserts records: create, keep, replace", async () => {
    const api = fakeApi();
    const cf = cloudflare({
      apiToken: "t",
      accountId: "acc",
      http: httpClient({ fetch: api.fetchImpl }),
    });
    expect(await cf.zoneId("x.test")).toBe("z1");
    expect(
      await cf.upsertRecord("z1", {
        type: "MX",
        name: "@",
        content: "smtp.google.com",
        priority: 1,
      }),
    ).toBe("created");
    expect(
      await cf.upsertRecord("z1", {
        type: "MX",
        name: "@",
        content: "SMTP.GOOGLE.COM",
        priority: 1,
      }),
    ).toBe("kept");
    expect(
      await cf.upsertRecord(
        "z1",
        { type: "MX", name: "@", content: "aspmx.l.google.com", priority: 1 },
        { replace: true },
      ),
    ).toBe("replaced");
    expect(
      await cf.upsertRecord("z1", { type: "TXT", name: "_dmarc", content: "v=DMARC1; p=none" }),
    ).toBe("created");
    expect(await cf.upsertRecord("z1", { type: "TXT", name: "@", content: "v=spf1 -all" })).toBe(
      "created",
    );
    expect(api.records.map((r) => `${r.type} ${r.name} ${r.content}`)).toEqual([
      "MX x.test aspmx.l.google.com",
      "TXT _dmarc.x.test v=DMARC1; p=none",
      "TXT x.test v=spf1 -all",
    ]);
    expect(await cf.registered("x.test")).toBe(false);
    expect(await cf.registered("ours.test")).toBe(true);
    // The token travels in a header, never in the URL.
    expect(api.calls.every((c) => !c.includes("t="))).toBe(true);
    // The zone name is looked up once, not once per record.
    expect(api.calls.filter((c) => c === "GET /client/v4/zones/z1")).toHaveLength(1);
  });

  it("checks prices 20 names a request and says why a name is not for sale", async () => {
    const api = fakeApi();
    const cf = cloudflare({
      apiToken: "t",
      accountId: "acc",
      http: httpClient({ fetch: api.fetchImpl }),
    });
    const names = ["taken.test", ...Array.from({ length: 21 }, (_, i) => `free${i}.test`)];
    const quotes = await cf.check(names);
    expect(quotes).toHaveLength(22);
    expect(quotes[0]).toEqual({
      name: "taken.test",
      registrable: false,
      reason: "domain_unavailable",
    });
    expect(quotes[1]).toEqual({
      name: "free0.test",
      registrable: true,
      price: "8.50",
      renewal: "11.20",
    });
    expect(api.calls.filter((c) => c.endsWith("/domain-check"))).toHaveLength(2);
  });
});

describe("domainIdeas", () => {
  it("spells the brand joined, hyphenated, plural and suffixed, per extension", () => {
    expect(domainIdeas(["Wren", "automation"], ["com"])).toEqual([
      "wrenautomation.com",
      "wrenautomations.com",
      "wren-automation.com",
      "wren-automations.com",
      "wrenautomationhq.com",
      "wrenautomationteam.com",
    ]);
    expect(domainIdeas(["acme"], [".io"])).toEqual([
      "acme.io",
      "acmes.io",
      "acmehq.io",
      "acmeteam.io",
    ]);
    expect(domainIdeas([])).toEqual([]);
  });

  it("adds one look-alike digit per place when asked", () => {
    expect(domainIdeas(["wren"], ["com"], { digits: true }).slice(4)).toEqual(["wr3n.com"]);
    expect(digitSwaps("solo")).toEqual(["5olo", "s0lo", "so1o", "sol0"]);
  });
});
