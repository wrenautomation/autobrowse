import { type ApiKeyInput, keyId, memoryKeys, type SecretUse } from "credvault";
import { afterEach, describe, expect, it, vi } from "vitest";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { memorySpent } from "../src/reach/key-ring.js";
import { type KeysDep, vaultSource } from "../src/reach/key-source.js";
import { memoryCaps } from "../src/sites/caps.js";
import { siteFacade, web } from "../src/sites/index.js";
import { fakeBrowser, fakeFetch } from "./fakes.js";

const noon = Date.UTC(2026, 9, 19, 12);
const key = (account: string, secret: string, more: Partial<ApiKeyInput> = {}): ApiKeyInput => ({
  site: "exa",
  account,
  owner: "wren",
  secret,
  purposes: [],
  status: "live",
  madeAt: "2026-10-01T00:00:00.000Z",
  ...more,
});

describe("web calls on a vault key", () => {
  afterEach(() => vi.unstubAllGlobals());

  function rig() {
    const sentWith: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sentWith.push((init.headers as Record<string, string>)["x-api-key"] ?? "");
      return new Response(JSON.stringify({ results: [] }));
    });
    const lines: SecretUse[] = [];
    const store = memoryKeys([
      key("a", "synthetic-a"),
      key("b", "synthetic-b"),
      key("old", "synthetic-o", { status: "revoked", revokedAt: "2026-10-02T00:00:00.000Z" }),
    ]);
    const keys: KeysDep = {
      source: vaultSource({ store, owner: "wren", env: async () => undefined, now: () => noon }),
      audit: { record: async (u) => void lines.push(u), recent: async () => lines },
      owner: "wren",
    };
    const caps = memoryCaps(() => noon);
    const sites = siteFacade([web], {
      http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      env: () => undefined,
      sink: memorySink(),
      runner: fakeBrowser([]),
      flow: () => null,
      caps,
      spent: memorySpent(),
      keys,
      now: () => noon,
    });
    return { sites, sentWith, lines, caps };
  }

  it("an unnamed call takes the first key and writes an audit line with the address, id and route", async () => {
    const { sites, sentWith, lines } = rig();
    await sites.call("web", "GET", "/people", { q: "q" }, undefined, { caller: "crm" });
    expect(sentWith).toEqual(["synthetic-a"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      credential: "exa@a",
      field: "secret",
      site: "exa",
      url: "https://api.exa.ai/search",
      by: "crm",
      owner: "wren",
      keyId: keyId("synthetic-a"),
      reason: "GET /people",
      allowed: true,
    });
    expect(JSON.stringify(lines)).not.toContain("synthetic-");
  });

  it("a call that names an account runs on that key, in that key's own budget", async () => {
    const { sites, sentWith, lines, caps } = rig();
    await sites.call("web", "GET", "/people", { q: "q" }, "exa@b");
    expect(sentWith).toEqual(["synthetic-b"]);
    expect(lines[0]).toMatchObject({ credential: "exa@b", by: "sites", allowed: true });
    expect(Object.keys(caps.today()).some((k) => k.includes("exa@b"))).toBe(true);
  });

  it("a named key that cannot answer is the caller's: nothing is sent, the refusal is audited", async () => {
    const { sites, sentWith, lines } = rig();
    await expect(sites.call("web", "GET", "/people", { q: "q" }, "exa@old")).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("exa@old is revoked"),
    });
    await expect(sites.call("web", "GET", "/people", { q: "q" }, "exa@nope")).rejects.toMatchObject(
      { status: 400 },
    );
    expect(sentWith).toEqual([]);
    expect(lines.map((l) => [l.credential, l.allowed])).toEqual([
      ["exa@old", false],
      ["exa@nope", false],
    ]);
  });
});
