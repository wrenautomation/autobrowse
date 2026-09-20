import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerEnvCommands } from "../src/app/cli-env.js";
import type { Settings } from "../src/app/config.js";
import {
  memoryEnvStore,
  parseDotenv,
  toDotenv,
  toExports,
  upsertDotenv,
} from "../src/deps/env-store.js";

describe("dotenv helpers", () => {
  it("parses as a shell would, inlines a JSON file a value names, and renders back", () => {
    const text = `# comment
export A=1
B="two words" # trailing
C='x'
SA=/tmp/sa.json
bad-name=1
EMPTY=
`;
    const entries = parseDotenv(text, (p) => (p === "/tmp/sa.json" ? '{"k":1}' : null));
    expect(entries).toEqual([
      { name: "A", value: "1" },
      { name: "B", value: "two words" },
      { name: "C", value: "x" },
      { name: "SA", value: '{"k":1}' },
    ]);
    expect(toExports([{ name: "P", value: "it's" }])).toBe("export P='it'\\''s'\n");
    expect(toDotenv([{ name: "A", value: "1" }])).toBe("A=1\n");
    expect(toDotenv([{ name: "SA", value: "{\n}" }], (n) => `/x/${n.toLowerCase()}.json`)).toBe(
      "SA=/x/sa.json\n",
    );
    expect(() => toDotenv([{ name: "SA", value: "{\n}" }])).toThrow(/spans lines/);
    expect(
      upsertDotenv("A=old\nKEEP=1\n", [
        { name: "A", value: "new" },
        { name: "Z", value: "9" },
      ]),
    ).toBe("A=new\nKEEP=1\nZ=9\n");
  });
});

describe("autobrowse env", () => {
  const setup = (initial: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "env-cli-"));
    const store = memoryEnvStore(initial);
    const said: string[] = [];
    let printed = "";
    const copied: string[] = [];
    const program = new Command().exitOverride();
    registerEnvCommands(program, { envFile: join(dir, ".env") } as Settings, {
      store: () => store,
      say: (l) => said.push(l),
      out: (t) => {
        printed += t;
      },
      clipboard: async (t) => {
        copied.push(t);
      },
    });
    const run = (...args: string[]) => program.parseAsync(["node", "autobrowse", "env", ...args]);
    return { dir, store, said, copied, run, printed: () => printed };
  };

  it("lists names only, copies one value, prints on request", async () => {
    const t = setup({ TWILIO_AUTH_TOKEN: "tok", A: "1" });
    await t.run("ls");
    expect(t.said.join("\n")).toMatch(/^A\s+\nTWILIO_AUTH_TOKEN/);
    expect(t.said.join("\n")).not.toContain("tok");
    await t.run("get", "TWILIO_AUTH_TOKEN");
    expect(t.copied).toEqual(["tok"]);
    expect(t.said.at(-1)).toMatch(/on the clipboard for 60s/);
    await t.run("get", "TWILIO_AUTH_TOKEN", "--print");
    expect(t.printed()).toBe("tok");
    await expect(t.run("get", "NOPE")).rejects.toThrow(/not in the store/);
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
});
