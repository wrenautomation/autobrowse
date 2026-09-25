import { describe, expect, it } from "vitest";
import { httpClient } from "../src/clients/http.js";
import { instantly } from "../src/clients/instantly.js";

/** Instantly's v2 shapes, as its docs give them. */
function fakeApi() {
  const calls: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization");
    calls.push(`${method} ${u.pathname} ${auth}${init?.body ? ` ${String(init.body)}` : ""}`);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.pathname === "/api/v2/accounts/a%40x.test")
      return json({ email: "a@x.test", status: 1, warmup_status: 0 });
    if (u.pathname.startsWith("/api/v2/accounts/") && method === "GET")
      return json({ message: "Account not found" }, 404);
    if (u.pathname === "/api/v2/oauth/google/init")
      return json({ session_id: "s1", auth_url: "https://accounts.google.com/o?x=1" });
    if (u.pathname === "/api/v2/oauth/session/status/s1")
      return json({ status: "error", error: "access_denied", error_description: "no" });
    if (u.pathname === "/api/v2/accounts/warmup/enable") return json({ id: "j1" });
    if (u.pathname === "/api/v2/background-jobs/j1") return json({ status: "success" });
    return json({ message: "nope" }, 401);
  };
  return { calls, client: instantly({ apiKey: "k", http: httpClient({ fetch: fetchImpl }) }) };
}

describe("instantly", () => {
  it("speaks v2 with a bearer key", async () => {
    const { calls, client } = fakeApi();
    expect(await client.account("a@x.test")).toEqual({
      email: "a@x.test",
      status: 1,
      warmupStatus: 0,
    });
    expect(await client.account("b@x.test")).toBeNull();
    expect(await client.oauthInit()).toEqual({
      sessionId: "s1",
      authUrl: "https://accounts.google.com/o?x=1",
    });
    expect(await client.oauthStatus("s1")).toEqual({
      status: "error",
      error: "access_denied",
      description: "no",
    });
    expect(await client.enableWarmup(["a@x.test"])).toBe("j1");
    expect(await client.job("j1")).toBe("success");
    expect(calls[0]).toBe("GET /api/v2/accounts/a%40x.test Bearer k");
    expect(calls[4]).toBe('POST /api/v2/accounts/warmup/enable Bearer k {"emails":["a@x.test"]}');
  });

  it("an error names the status, never the key", async () => {
    const { client } = fakeApi();
    const err = await client.job("other").catch((e: Error) => e);
    expect(String(err)).toMatch(/HTTP 401 nope/);
    expect(String(err)).not.toMatch(/Bearer/);
  });
});
