import { Command } from "commander";
import { applyProjection, keyId, memoryEnvStore, memoryKeys, type SecretUse } from "credvault";
import { describe, expect, it } from "vitest";
import { registerKeyCommands } from "../src/app/cli-keys.js";
import type { Settings } from "../src/app/config.js";
import { ownerKeysIn } from "../src/reach/key-source.js";

const NOW = Date.UTC(2026, 9, 19, 12);

function setup(init: { env?: Record<string, string>; owner?: string } = {}) {
  const owner = init.owner ?? "wren";
  const keys = memoryKeys();
  const env = memoryEnvStore(init.env ?? {});
  const said: string[] = [];
  const lines: SecretUse[] = [];
  let pasted = "";
  let piped = "";
  let code = 0;
  const projected: string[][] = [];
  const program = new Command().exitOverride();
  const creds = program.command("creds");
  registerKeyCommands(creds, { owner } as Settings, {
    keys: () => keys,
    env: () => env,
    project: async (vendors) => {
      projected.push(vendors);
      return applyProjection(env, await ownerKeysIn(keys, owner), { vendors });
    },
    audit: () => ({
      record: async (u) => void lines.push(u),
      recent: async () => lines,
    }),
    paste: async () => pasted,
    input: async () => piped,
    say: (l) => said.push(l),
    exit: (c) => {
      code = c;
    },
    now: () => NOW,
  });
  const run = (...args: string[]) =>
    program.parseAsync(["node", "autobrowse", "creds", "key", ...args]);
  return {
    keys,
    env,
    said,
    lines,
    projected,
    run,
    paste: (t: string) => {
      pasted = t;
    },
    pipe: (t: string) => {
      piped = t;
    },
    code: () => code,
    out: () => said.join("\n"),
  };
}

describe("creds key add", () => {
  it("stores a key from the clipboard, projects its vendor, prints no value", async () => {
    const t = setup();
    t.paste("EXA_API_KEY='synthetic-a'\n");
    await t.run("add", "exa@main", "--clipboard", "--purpose", "default", "research");
    const key = await t.keys.get("exa@main");
    expect(key?.secret).toBe("synthetic-a");
    expect(key?.owner).toBe("wren");
    expect(key?.purposes).toEqual(["default", "research"]);
    expect(t.env.values.EXA_API_KEY).toBe("synthetic-a");
    expect(t.projected).toEqual([["exa"]]);
    expect(t.out()).toContain(`added exa@main (id ${keyId("synthetic-a")}) for wren`);
    expect(t.out()).toContain("put EXA_API_KEY");
    expect(t.out()).not.toContain("synthetic-a");
  });

  it("reads piped stdin when there is no --clipboard", async () => {
    const t = setup();
    t.pipe("synthetic-p\n");
    await t.run("add", "brave@x");
    expect((await t.keys.get("brave@x"))?.secret).toBe("synthetic-p");
  });

  it("refuses a value another key already holds, naming that address", async () => {
    const t = setup();
    t.paste("synthetic-a");
    await t.run("add", "exa@main", "--clipboard");
    await expect(t.run("add", "exa@second", "--clipboard")).rejects.toThrow(
      "that key is already exa@main",
    );
    expect(await t.keys.get("exa@second")).toBeNull();
  });

  it("a new value on an existing label replaces it and records the old id", async () => {
    const t = setup();
    t.paste("synthetic-a");
    await t.run("add", "exa@main", "--clipboard", "--purpose", "default");
    t.paste("synthetic-b");
    await t.run("add", "exa@main", "--clipboard");
    const key = await t.keys.get("exa@main");
    expect(key?.secret).toBe("synthetic-b");
    expect(key?.purposes).toEqual(["default"]);
    expect(key?.previous.map((p) => p.id)).toEqual([keyId("synthetic-a")]);
    expect(t.env.values.EXA_API_KEY).toBe("synthetic-b");
    expect(t.out()).toContain("revoke it there");
  });

  it("takes a cap and shows it", async () => {
    const t = setup();
    t.paste("synthetic-a");
    await t.run("add", "exa@main", "--clipboard", "--cap", "1000", "--cap-unit", "calls");
    expect((await t.keys.get("exa@main"))?.cap).toEqual({ amount: 1000, unit: "calls" });
    t.said.length = 0;
    await t.run("ls");
    expect(t.out()).toContain("cap 1000 calls");
  });

  it("an owner's process refuses an operator vendor, saying why", async () => {
    const t = setup({ owner: "client" });
    t.paste("synthetic-a");
    await expect(t.run("add", "exa@main", "--clipboard")).rejects.toThrow(
      "exa is the operator's tool key: it reaches client through env, never client's vault",
    );
    t.paste("synthetic-b");
    await t.run("add", "instantly@main", "--clipboard");
    expect((await t.keys.get("instantly@main"))?.owner).toBe("client");
  });

  it("refuses a purpose another live key holds", async () => {
    const t = setup();
    t.paste("synthetic-a");
    await t.run("add", "exa@a", "--clipboard", "--purpose", "default");
    t.paste("synthetic-b");
    await expect(t.run("add", "exa@b", "--clipboard", "--purpose", "default")).rejects.toThrow(
      /exa@a already holds default/,
    );
  });
});

describe("creds key ls, spend, revoke, purpose, audit", () => {
  async function two() {
    const t = setup();
    t.paste("synthetic-a");
    await t.run("add", "exa@a", "--clipboard", "--purpose", "default");
    t.paste("synthetic-b");
    await t.run("add", "exa@b", "--clipboard");
    t.said.length = 0;
    return t;
  }

  it("ls shows address, owner, status, id and uses, never a value", async () => {
    const t = await two();
    t.lines.push({
      at: "2026-10-18T10:00:00.000Z",
      credential: "exa@a",
      field: "secret",
      site: "exa",
      url: "https://api.exa.ai/search",
      by: "search",
      owner: "wren",
      keyId: keyId("synthetic-a"),
      allowed: true,
    });
    await t.run("ls");
    const out = t.out();
    expect(out).toContain("exa@a");
    expect(out).toContain(keyId("synthetic-a"));
    expect(out).toContain("1 uses, last 2026-10-18T10:00:00.000Z");
    expect(out).toContain("default");
    expect(out).not.toContain("synthetic-");
  });

  it("spend marks a key until the 1st of next month, or a date, and re-projects", async () => {
    const t = await two();
    await t.run("spend", "exa@a");
    expect((await t.keys.get("exa@a"))?.status).toBe("spent");
    expect((await t.keys.get("exa@a"))?.spentUntil).toBe("2026-11-01T00:00:00.000Z");
    expect(t.out()).toContain("exa@a is spent until 2026-11-01");
    await t.run("spend", "exa@b", "--until", "2026-12-15");
    expect((await t.keys.get("exa@b"))?.spentUntil).toBe("2026-12-15T00:00:00.000Z");
    t.said.length = 0;
    await t.run("ls");
    expect(t.out()).toContain("spent until 2026-11-01");
    await expect(t.run("spend", "exa@nope")).rejects.toThrow("no key exa@nope");
    await expect(t.run("spend", "exa@a", "--until", "soon")).rejects.toThrow(/not a date/);
  });

  it("revoke hides a key unless --all, drops it from the env and says to revoke at the vendor", async () => {
    const t = await two();
    await t.run("revoke", "exa@b");
    const key = await t.keys.get("exa@b");
    expect(key?.status).toBe("revoked");
    expect(key?.revokedAt).toBe(new Date(NOW).toISOString());
    expect(t.out()).toContain("revoke it at the vendor too");
    expect(t.env.values.EXA_API_KEY_1).toBeUndefined();
    expect(t.env.values.NUM_EXA).toBeUndefined();
    t.said.length = 0;
    await t.run("ls");
    expect(t.out()).not.toContain("exa@b");
    t.said.length = 0;
    await t.run("ls", "--all");
    expect(t.out()).toContain("exa@b");
    expect(t.out()).toContain("revoked");
  });

  it("purpose moves a purpose from the key that held it", async () => {
    const t = await two();
    await t.run("purpose", "exa@b", "default", "bulk");
    expect((await t.keys.get("exa@a"))?.purposes).toEqual([]);
    expect((await t.keys.get("exa@b"))?.purposes).toEqual(["default", "bulk"]);
    // The bare env name now follows the key that holds default.
    expect(t.env.values.EXA_API_KEY).toBe("synthetic-b");
  });

  it("audit lists the uses and refusals of one key, newest last", async () => {
    const t = await two();
    const use = (at: string, extra: Partial<SecretUse>): SecretUse => ({
      at,
      credential: "exa@a",
      field: "secret",
      site: "exa",
      url: "https://api.exa.ai/search",
      by: "search",
      allowed: true,
      ...extra,
    });
    t.lines.push(
      use("2026-10-17T00:00:00.000Z", { keyId: keyId("synthetic-a"), reason: "GET /search" }),
      use("2026-10-17T01:00:00.000Z", { credential: "exa@b", keyId: keyId("synthetic-b") }),
      use("2026-10-18T00:00:00.000Z", { allowed: false, reason: "GET /search: no key" }),
    );
    await t.run("audit", "exa@a");
    const out = t.said;
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("2026-10-17T00:00:00.000Z");
    expect(out[1]).toContain("REFUSED");
    await t.run("audit", "exa@a", "-n", "1");
    expect(t.said.at(-1)).toContain("REFUSED");
  });
});

describe("creds key project", () => {
  it("--check is quiet and exits 0 when the env equals the vault, exits 1 and names the differing names when not", async () => {
    const t = setup();
    t.paste("synthetic-a");
    await t.run("add", "exa@a", "--clipboard");
    t.said.length = 0;
    await t.run("project", "--check");
    expect(t.code()).toBe(0);
    expect(t.out()).toContain("env equals the vault");
    t.env.values.EXA_API_KEY = "hand-edited";
    t.said.length = 0;
    await t.run("project", "--check");
    expect(t.code()).toBe(1);
    expect(t.out()).toContain(
      `EXA_API_KEY: vault ${keyId("synthetic-a")}, env ${keyId("hand-edited")}`,
    );
    expect(t.out()).not.toContain("hand-edited");
    expect(t.out()).not.toContain("synthetic-a");
    await t.run("project");
    expect(t.env.values.EXA_API_KEY).toBe("synthetic-a");
  });
});

describe("creds key migrate", () => {
  const ENV = {
    X_API_KEY: "synthetic-x0",
    X_API_KEY_1: "synthetic-x1",
    X_API_KEY_2: "synthetic-x2",
    NUM_X: "2",
    Y_API_KEY: "synthetic-y",
    UNRELATED_TOKEN: "stays",
  };

  it("a dry run lists what it would make and writes nothing", async () => {
    const t = setup({ env: { ...ENV } });
    await t.run("migrate");
    expect(await t.keys.list()).toEqual([]);
    expect(t.out()).toContain(`would make x@env-0 (id ${keyId("synthetic-x0")}) purposes default`);
    expect(t.out()).toContain("would make x@env-1");
    expect(t.out()).toContain("would make x@env-2");
    expect(t.out()).toContain("would make y@env-0");
    expect(t.out()).toContain("dry run: 4 keys to migrate for x, y; nothing written");
    expect(t.out()).not.toContain("synthetic-");
    expect(t.code()).toBe(0);
    expect(t.env.values).toEqual(ENV);
  });

  it("--apply makes the keys, the projection writes nothing, the env equals the vault", async () => {
    const t = setup({ env: { ...ENV } });
    await t.run("migrate", "--apply");
    expect((await t.keys.list()).map((k) => k.address)).toEqual([
      "x@env-0",
      "x@env-1",
      "x@env-2",
      "y@env-0",
    ]);
    expect(t.out()).toContain("projection put nothing; removed nothing");
    expect(t.out()).toContain("migrated 4 keys for x, y; env equals the vault");
    expect(t.code()).toBe(0);
    expect(t.env.values).toEqual(ENV);
    t.said.length = 0;
    await t.run("project", "--check");
    expect(t.code()).toBe(0);
  });

  it("a second apply skips every key", async () => {
    const t = setup({ env: { ...ENV } });
    await t.run("migrate", "--apply");
    t.said.length = 0;
    await t.run("migrate", "--apply");
    expect(t.out()).toContain(`already in the vault: x@env-0 (id ${keyId("synthetic-x0")})`);
    expect(t.out()).toContain("migrated 0 keys for x, y; env equals the vault");
    expect((await t.keys.list()).length).toBe(4);
  });

  it("an env hand-edited so _2 equals _1 stops before writing: the projection would change it", async () => {
    const t = setup({ env: { ...ENV, X_API_KEY_2: "synthetic-x1" } });
    await t.run("migrate", "--apply");
    expect(t.code()).toBe(1);
    expect(await t.keys.list()).toEqual([]);
    expect(t.out()).toContain("skipped X_API_KEY_2: same key as X_API_KEY_1");
    expect(t.out()).toContain("nothing written");
    expect(t.out()).toContain("NUM_X");
    expect(t.out()).toContain("X_API_KEY_2");
  });

  it("an address held by a different id stops the run", async () => {
    const t = setup({ env: { ...ENV } });
    await t.keys.put({
      site: "y",
      account: "env-0",
      owner: "wren",
      secret: "synthetic-other",
      purposes: [],
      status: "live",
      madeAt: "2026-10-01T00:00:00.000Z",
    });
    await t.run("migrate", "--apply");
    expect(t.code()).toBe(1);
    expect(t.out()).toContain(
      `y@env-0 is held by id ${keyId("synthetic-other")}, not ${keyId("synthetic-y")}`,
    );
    expect((await t.keys.list()).map((k) => k.address)).toEqual(["y@env-0"]);
  });

  it("an owner's migration leaves the operator's tool keys out", async () => {
    const t = setup({
      owner: "client",
      env: { EXA_API_KEY: "synthetic-e", Y_API_KEY: "synthetic-y" },
    });
    await t.run("migrate", "--apply");
    expect((await t.keys.list()).map((k) => k.address)).toEqual(["y@env-0"]);
    expect(t.out()).toContain("skipped exa@env-0: operator tool key");
  });
});
