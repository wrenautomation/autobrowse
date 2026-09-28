import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refusal } from "../src/access/fence.js";
import {
  allowsSite,
  allowsWorkflow,
  fileKeys,
  OWNER,
  type Scope,
  seesSite,
} from "../src/access/keys.js";
import type { Ability } from "../src/do/catalog.js";
import { mayUse } from "../src/do/wire.js";

const designer: Scope = {
  owner: false,
  name: "designer",
  sites: ["higgsfield", "canva@*", "github@wren"],
  workflows: ["higgsfield-*"],
  tools: ["ffmpeg"],
  can: ["do", "agent"],
};

describe("agent keys", () => {
  it("a site entry names its accounts: bare = the default one, @x = that one, @* = all", () => {
    expect(allowsSite(designer, "higgsfield")).toBe(true);
    expect(allowsSite(designer, "higgsfield@other")).toBe(false);
    expect(allowsSite(designer, "canva")).toBe(true);
    expect(allowsSite(designer, "canva@team")).toBe(true);
    expect(allowsSite(designer, "github@wren")).toBe(true);
    expect(allowsSite(designer, "github")).toBe(false);
    expect(seesSite(designer, "github")).toBe(true);
    expect(allowsSite(designer, "google")).toBe(false);
    expect(allowsSite(OWNER, "google")).toBe(true);
    expect(allowsWorkflow(designer, "higgsfield-video")).toBe(true);
    expect(allowsWorkflow(designer, "domain")).toBe(false);
  });

  it("the catalog shows only what the key may use", () => {
    const ab = (kind: Ability["kind"], name: string, site: string | null): Ability => ({
      kind,
      name,
      site,
      summary: "",
      inputs: [],
      irreversible: false,
      ready: true,
      missing: null,
    });
    const all = [
      ab("site", "higgsfield POST /v1/images", "higgsfield"),
      ab("site", "gmail GET /messages", "gmail"),
      ab("workflow", "higgsfield-video", null),
      ab("workflow", "domain", null),
      ab("flow", "google/profile-photo", "google"),
      ab("tool", "ffmpeg", null),
      ab("tool", "wrangler", null),
    ];
    expect(all.filter((a) => mayUse(designer, a)).map((a) => a.name)).toEqual([
      "higgsfield POST /v1/images",
      "higgsfield-video",
      "ffmpeg",
    ]);
  });

  it("stores a hash, never the key; resolves, replaces and revokes", () => {
    const file = join(mkdtempSync(join(tmpdir(), "keys-")), "agent-keys.json");
    const keys = fileKeys(file);
    const { key } = keys.add("designer", {
      sites: ["higgsfield"],
      workflows: [],
      tools: [],
      can: ["do"],
    });
    expect(readFileSync(file, "utf8")).not.toContain(key.slice(12));
    expect(keys.resolve(key)).toMatchObject({
      owner: false,
      name: "designer",
      sites: ["higgsfield"],
    });
    expect(keys.resolve(`${key}x`)).toBeNull();
    const second = keys.add("designer", { sites: [], workflows: [], tools: [], can: [] }).key;
    expect(keys.resolve(key)).toBeNull();
    expect(keys.resolve(second)?.name).toBe("designer");
    expect(keys.revoke("designer")).toBe(true);
    expect(keys.resolve(second)).toBeNull();
    expect(() => keys.add("owner", { sites: [], workflows: [], tools: [], can: [] })).toThrow();
  });

  it("the door: agent routes by scope, everything else the owner's", () => {
    const look = {
      sessionSite: (id: string) => (id === "s1" ? "higgsfield" : id === "s2" ? "google" : null),
    };
    const r = (method: string, path: string, query: Record<string, string> = {}) =>
      refusal(designer, method, path, query, look);
    expect(r("GET", "/api/abilities")).toBeNull();
    expect(r("POST", "/api/do")).toBeNull();
    expect(r("GET", "/api/accounts")).toMatch(/owner/);
    expect(r("GET", "/api/ledger")).toMatch(/owner/);
    expect(r("PUT", "/api/settings")).toMatch(/owner/);
    expect(r("GET", "/api/recordings")).toMatch(/owner/);
    // Site APIs need the `sites` verb, which this key lacks.
    expect(r("POST", "/api/sites/higgsfield/v1/images")).toMatch(/may not sites/);
    expect(
      refusal(
        { ...designer, can: ["sites"] },
        "GET",
        "/api/sites/github/user",
        { account: "wren" },
        look,
      ),
    ).toBeNull();
    expect(
      refusal({ ...designer, can: ["sites"] }, "GET", "/api/sites/github/user", {}, look),
    ).toMatch(/github/);
    expect(r("POST", "/api/sites/higgsfield/setup/token")).toMatch(/owner/);
    expect(r("POST", "/api/runs/higgsfield-video/k1")).toMatch(/may not run/);
    expect(
      refusal({ ...designer, can: ["run"] }, "POST", "/api/runs/higgsfield-video/k1", {}, look),
    ).toBeNull();
    expect(refusal({ ...designer, can: ["run"] }, "POST", "/api/runs/domain/k1", {}, look)).toMatch(
      /domain/,
    );
    expect(
      refusal(
        { ...designer, can: ["run"] },
        "POST",
        "/api/runs/higgsfield-video/k1/approve",
        {},
        look,
      ),
    ).toMatch(/owner/);
    expect(r("POST", "/api/agent/s1/pause")).toBeNull();
    expect(r("POST", "/api/agent/s2/pause")).toMatch(/google/);
    expect(r("POST", "/api/agent/s1/exec")).toMatch(/owner/);
    expect(r("POST", "/api/agent/heal")).toMatch(/owner/);
    expect(refusal(OWNER, "POST", "/api/agent/heal", {}, look)).toBeNull();
  });
});
