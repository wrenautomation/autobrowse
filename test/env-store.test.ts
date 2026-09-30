import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { memoryEnvStore } from "credvault";
import { describe, expect, it } from "vitest";
import { registerEnvCommands } from "../src/app/cli-env.js";
import type { Settings } from "../src/app/config.js";

describe("autobrowse env", () => {
  const setup = (initial: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "env-cli-"));
    const store = memoryEnvStore(initial);
    const said: string[] = [];
    let printed = "";
    let pasted = "";
    const copied: string[] = [];
    const program = new Command().exitOverride();
    registerEnvCommands(program, { envFile: join(dir, ".env"), owner: "wren" } as Settings, {
      store: () => store,
      say: (l) => said.push(l),
      out: (t) => {
        printed += t;
      },
      clipboard: async (t) => {
        copied.push(t);
      },
      paste: async () => pasted,
    });
    const run = (...args: string[]) => program.parseAsync(["node", "autobrowse", "env", ...args]);
    const paste = (t: string) => {
      pasted = t;
    };
    return { dir, store, said, copied, run, paste, printed: () => printed };
  };

  it("lists names only, copies one value, prints on request", async () => {
    const t = setup({ TWILIO_AUTH_TOKEN: "tok", A: "1" });
    await t.run("ls");
    expect(t.said.join("\n")).toMatch(/^A\nTWILIO_AUTH_TOKEN/);
    expect(t.said.join("\n")).not.toContain("tok");
    await t.run("get", "TWILIO_AUTH_TOKEN");
    expect(t.copied).toEqual(["tok"]);
    expect(t.said.at(-1)).toMatch(/on the clipboard for 60s/);
    await t.run("get", "TWILIO_AUTH_TOKEN", "--print");
    expect(t.printed()).toBe("tok");
    await expect(t.run("get", "NOPE")).rejects.toThrow(/not in the store/);
  });

  it("records an expiry without printing the value, shows it in ls, and clears it", async () => {
    const t = setup({ NPM_TOKEN: "tok" });
    await t.run("expires", "NPM_TOKEN", "2026-12-21");
    expect(t.said.at(-1)).toBe("NPM_TOKEN expires 2026-12-21T00:00:00.000Z");
    expect(await t.store.get("NPM_TOKEN")).toBe("tok");
    await t.run("ls");
    expect(t.said.at(-1)).toMatch(/^NPM_TOKEN\s+expires 2026-12-21T00:00:00.000Z$/);
    await t.run("expires", "NPM_TOKEN", "none");
    expect((await t.store.list())[0]?.expiresAt).toBeNull();
    expect(t.said.join("\n")).not.toContain("tok");
    await expect(t.run("expires", "NPM_TOKEN", "soon")).rejects.toThrow(/not a date/);
    await expect(t.run("expires", "NOPE", "2026-12-21")).rejects.toThrow(/not in the store/);
  });

  it("pulls into a 0600 env file (merged), as exports, or to stdout; sidecars for multi-line values", async () => {
    const t = setup({ A: "1", SA: '{\n "k": 1\n}', B: "2" });
    writeFileSync(join(t.dir, ".env"), "LOCAL=keep\nA=old\n");
    await t.run("pull");
    const env = readFileSync(join(t.dir, ".env"), "utf8");
    expect(env).toBe(`LOCAL=keep\nA=1\nB=2\nSA=${join(t.dir, "sa.json")}\n`);
    expect(statSync(join(t.dir, ".env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(t.dir, "sa.json"), "utf8")).toBe('{\n "k": 1\n}');
    await t.run("pull", "B", "--export");
    expect(t.printed()).toBe("export B='2'\n");
    await expect(t.run("pull", "NOPE")).rejects.toThrow(/not in the store: NOPE/);
  });

  it("pushes named keys from .env, or every key of a file; refuses a bare push", async () => {
    const t = setup({});
    writeFileSync(
      join(t.dir, ".env"),
      "TWILIO_ACCOUNT_SID=AC1\nTWILIO_AUTH_TOKEN=tok\nLOG_LEVEL=debug\n",
    );
    await expect(t.run("push")).rejects.toThrow(/name what to push/);
    await t.run("push", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN");
    expect(t.store.values).toEqual({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok" });
    expect(t.said.at(-2)).toBe("pushed 2: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN");
    await expect(t.run("push", "MISSING")).rejects.toThrow(/not in .*MISSING/);
    writeFileSync(join(t.dir, "prod.env"), "X=1\nY=2\n");
    await t.run("push", "--from", join(t.dir, "prod.env"));
    expect(Object.keys(t.store.values).sort()).toEqual([
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "X",
      "Y",
    ]);
    await t.run("rm", "X");
    expect(t.store.values.X).toBeUndefined();
    expect(t.said.at(-1)).toBe("removed X");
  });
  it("sets a new value from the clipboard into the store and .env, cleaned of a pasted line or quotes", async () => {
    const t = setup({});
    t.paste("  INSTANTLY_API_KEY='k1'\n");
    await t.run("set", "INSTANTLY_API_KEY", "--clipboard");
    expect(await t.store.get("INSTANTLY_API_KEY")).toBe("k1");
    expect(readFileSync(join(t.dir, ".env"), "utf8")).toMatch(/^INSTANTLY_API_KEY=k1$/m);
    expect(t.said.join("\n")).not.toContain("k1");
    t.paste("");
    await expect(t.run("set", "X", "--clipboard")).rejects.toThrow(/empty/);
    t.paste("a\nb");
    await expect(t.run("set", "X", "--clipboard")).rejects.toThrow(/line breaks/);
    await expect(t.run("set", "lower", "--clipboard")).rejects.toThrow(/not an env name/);
    t.paste("k2");
    await t.run("set", "ONLY_THERE", "--clipboard", "--store-only");
    expect(readFileSync(join(t.dir, ".env"), "utf8")).not.toContain("ONLY_THERE");
  });
  it("a push of a name only in the store says so; one in neither place is an error", async () => {
    const t = setup({ ONLY_THERE: "v" });
    await t.run("push", "ONLY_THERE");
    expect(t.said.join("\n")).toMatch(/already in the store/);
    await expect(t.run("push", "NOWHERE")).rejects.toThrow(/not in .* or the store: NOWHERE/);
  });
});
