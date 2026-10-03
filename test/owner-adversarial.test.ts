/**
 * Owner keys, attacked (designs/2026-09-30-owner-keys.md): names that only
 * look valid, env that tries to cross owners, the once-per-process fence,
 * paths an owner's env should not move, prefixes and keys that must never
 * overlap. No network, no Keychain, no real home: temp dirs and fakes only.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SSMClient } from "@aws-sdk/client-ssm";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileKeys, type KeyStore, type Scope } from "../src/access/keys.js";
import { ENV_KEYS, loadSettings, OWNER_PATHS, ownerDir } from "../src/app/config.js";
import { commandFor, fileDone } from "../src/app/needs.js";
import { awsFor, enterOwner, ownerFromArgv } from "../src/app/owner.js";
import { envStoreFor, phoneFor, shipperFor } from "../src/app/services.js";
import { KEYCHAIN, keychainOf, WALLET_KEYCHAIN } from "../src/auth/keep.js";
import { DEFAULT_DB } from "../src/devices/phone.js";
import { expandHome } from "../src/google-auth.js";
import { awsConfig, awsConfigFromEnv, checkOwner, named, ownerKeys } from "../src/owner.js";
import { accessAuth } from "../src/ui/auth.js";

// Shots go to a fake S3: every put is kept here, nothing leaves the machine.
const puts = vi.hoisted(() => [] as Array<{ Bucket?: string; Key?: string }>);
vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class S3Client {
    async send(command: { input: { Bucket?: string; Key?: string } }) {
      puts.push(command.input);
      return {};
    }
  }
  return { S3Client, PutObjectCommand: Command, GetObjectCommand: Command };
});

const ROLE = "arn:aws:iam::000000000000:role/autobrowse-owners";
const INGRESS = { RESTATE_INGRESS_URL: "http://127.0.0.1:8080" };

function ownersDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "owners-adv-"));
  for (const [owner, text] of Object.entries(files)) {
    mkdirSync(join(dir, owner), { recursive: true });
    writeFileSync(join(dir, owner, ".env"), text);
  }
  return dir;
}

/** The live `process.env` is exactly `env` while `f` runs (synchronously); every name is put back after. */
function withOnlyEnv<T>(env: Record<string, string>, f: () => T): T {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return f();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
}

/** What `f` threw, or null when it returned. */
function thrown(f: () => unknown): Error | null {
  try {
    f();
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** Owner and config modules with no owner entered yet: the once-per-process mark is module state. */
async function fresh() {
  vi.resetModules();
  const owner = await import("../src/app/owner.js");
  const config = await import("../src/app/config.js");
  return { enterOwner: owner.enterOwner, loadSettings: config.loadSettings };
}

describe("once per process", () => {
  it("a process entered for an owner cannot enter again as the default owner", async () => {
    const m = await fresh();
    const dir = ownersDir({ acme: "ACME_ONLY=1\n" });
    withOnlyEnv({ AUTOBROWSE_OWNER: "acme", OWNERS_DIR: dir }, () => {
      m.enterOwner(process.env);
      process.env.AUTOBROWSE_OWNER = "wren";
      expect(() => m.enterOwner(process.env)).toThrow(/once/);
    });
  });

  it("a process entered for an owner never loads the default owner's settings", async () => {
    const m = await fresh();
    const dir = ownersDir({ acme: "ACME_ONLY=1\n" });
    withOnlyEnv({ ...INGRESS, AUTOBROWSE_OWNER: "acme", OWNERS_DIR: dir }, () => {
      m.enterOwner(process.env);
      expect(m.loadSettings().owner).toBe("acme");
      // Gone from the env (a later write, a delete): the operator's files, Keychain and SSM path must stay shut.
      delete process.env.AUTOBROWSE_OWNER;
      expect(() => m.loadSettings()).toThrow(/entered|once/);
    });
  });

  it("a process that entered the default owner cannot enter another", async () => {
    const m = await fresh();
    const dir = ownersDir({ acme: "ACME_ONLY=1\n" });
    withOnlyEnv({ OWNERS_DIR: dir, CLOUDFLARE_API_TOKEN: "op-cf" }, () => {
      expect(m.enterOwner(process.env)).toBe("wren");
      process.env.AUTOBROWSE_OWNER = "acme";
      expect(() => m.enterOwner(process.env)).toThrow(/once/);
    });
  });

  it("a second entry throws, for the same owner or another, and another's settings stay shut", async () => {
    const m = await fresh();
    const dir = ownersDir({ acme: "", bob: "" });
    withOnlyEnv({ ...INGRESS, AUTOBROWSE_OWNER: "acme", OWNERS_DIR: dir }, () => {
      m.enterOwner(process.env);
      expect(() => m.enterOwner(process.env)).toThrow(/once/);
      process.env.AUTOBROWSE_OWNER = "bob";
      expect(() => m.enterOwner(process.env)).toThrow(/once/);
      expect(() => m.loadSettings()).toThrow(/not entered/);
    });
  });

  it("the live boot path: the owner's accounts in, the operator's out, files under the owner", async () => {
    const m = await fresh();
    const dir = ownersDir({ acme: "CLOUDFLARE_API_TOKEN=acme-cf\n" });
    const operator = {
      ...INGRESS,
      AUTOBROWSE_OWNER: "acme",
      OWNERS_DIR: dir,
      CLOUDFLARE_API_TOKEN: "op-cf",
      GITHUB_TOKEN: "op-gh",
      AUTOBROWSE_CRED_GITHUB: "op-cred",
      FROM_THE_FILE: "op-file",
      EXA_API_KEY: "op-exa",
    };
    const seen = withOnlyEnv(operator, () => {
      m.enterOwner(process.env, ["FROM_THE_FILE"]);
      return { env: { ...process.env }, settings: m.loadSettings() };
    });
    expect(seen.settings.cloudflareApiToken).toBe("acme-cf");
    expect(seen.settings.githubToken).toBeUndefined();
    expect(seen.settings.credentialsFile).toBe(join(dir, "acme", "credentials.json"));
    expect(seen.env.AUTOBROWSE_CRED_GITHUB).toBeUndefined();
    expect(seen.env.FROM_THE_FILE).toBeUndefined();
    expect(seen.env.EXA_API_KEY).toBe("op-exa");
  });
});

describe("an owner's env", () => {
  it("cannot move its fixed files by setting HOME", async () => {
    const m = await fresh();
    const home = mkdtempSync(join(tmpdir(), "op-home-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "owner-home-"));
    const own = join(home, ".config", "autobrowse", "owners", "acme");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, ".env"), `HOME=${elsewhere}\n`);
    withOnlyEnv({ ...INGRESS, HOME: home, AUTOBROWSE_OWNER: "acme" }, () => {
      const err = thrown(() => m.enterOwner(process.env));
      if (err) {
        // Refusing HOME is one fix; the error then names the key, never the value.
        expect(err.message).toMatch(/HOME/);
        expect(err.message).not.toContain(elsewhere);
        return;
      }
      const s = m.loadSettings();
      // Its .env is the file it was entered from; every fixed file sits beside it.
      expect(expandHome(s.envFile)).toBe(join(own, ".env"));
      expect(expandHome(s.credentialsFile)).toBe(join(own, "credentials.json"));
    });
  });

  it("may set no fixed path, operator setting, flag or tool key; the error names the key, never the value", () => {
    const names = [
      ...(Object.keys(OWNER_PATHS) as (keyof typeof OWNER_PATHS)[]).map((k) => ENV_KEYS[k]),
      "AUTOBROWSE_DEBUG",
      "AUTOBROWSE_OWNER_ROLE_ARN",
      "OWNERS_DIR",
      "AWS_CONFIG_FILE",
      "AWS_SHARED_CREDENTIALS_FILE",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AWS_ROLE_ARN",
      "BRAVE_API_KEY",
      "JINA_API_KEY",
      "PERPLEXITY_API_KEY",
      "LANGFUSE_HOST",
      "LANGFUSE_PUBLIC_KEY",
      "SHOTS_BUCKET",
      "SHOTS_ENDPOINT",
      "SHOTS_MACHINE",
      "SECRET_SINK",
      "CREDENTIALS_CIPHER",
      "CREDENTIALS_SHARED",
      "UI_TOKEN",
      "UI_HOST",
      "RESTATE_INGRESS_URL",
      "RESTATE_TUNNEL_NAME",
      "LINQ_API_KEY",
      "TWILIO_AUTH_TOKEN",
      "NOTIFY_TO",
      "SPEND_HARD_CAP",
      "WALLET_DEBIT_HOSTS",
      "GUARDS",
      "FIXES_FILE",
      "SCREENS_FILE",
    ];
    const dir = ownersDir({ acme: "" });
    for (const name of names) {
      const value = `leak-${name.toLowerCase()}`;
      writeFileSync(join(dir, "acme", ".env"), `  ${name} = "${value}"\n`);
      const err = thrown(() => enterOwner({ AUTOBROWSE_OWNER: "acme", OWNERS_DIR: dir }));
      expect(err?.message, name).toContain(name);
      expect(err?.message, name).not.toContain(value);
    }
    writeFileSync(
      join(dir, "acme", ".env"),
      "AWS_REGION=leak-one\nUI_TOKEN=leak-two\nCREDENTIALS_FILE=leak-three\n",
    );
    const all = thrown(() => enterOwner({ AUTOBROWSE_OWNER: "acme", OWNERS_DIR: dir }));
    expect(all?.message).toMatch(/AWS_REGION, UI_TOKEN, CREDENTIALS_FILE/);
    expect(all?.message).not.toMatch(/leak-/);
  });

  it("drops the operator's accounts whatever their case or shape, keeps what the process needs", () => {
    const dropped: Record<string, string> = {
      github_token: "op",
      Stripe_Secret: "op",
      DB_PASSWD: "op",
      SMTP_PASS: "op",
      SESSION_COOKIES: "op",
      SESSION_COOKIE: "op",
      DATABASE_DSN: "op",
      GOOGLE_APPLICATION_CREDENTIALS: "op",
      PROXY_AUTH: "op",
      ACCOUNT_SID: "op",
      GCP_PROJECT: "op",
      SERVICE_ACCOUNT: "op",
      DB_USER: "op",
      SMTP_USERNAME: "op",
      OWNER_EMAIL: "op",
      SLACK__WILLIAM: "op",
      slack__william: "op",
      SIGNING_KEY: "op",
      GMAIL_ANYTHING: "op",
      BROWSERBASE_CONTEXT_REDDIT: "op",
      AUTOBROWSE_ANYTHING: "op",
      // Owner settings and fixed paths from the operator's shell, not only its file.
      CLOUDFLARE_ACCOUNT_ID: "op",
      GOOGLE_ADMIN_USER: "op@op.com",
      PHONE_NUMBER: "+15550000000",
      BACKBOARD_ASSISTANT: "op",
      ROSTER_SSM_PARAM: "/op",
      BROWSER_CDP_URL: "http://127.0.0.1:9222",
      OWN_BROWSER: "1",
      CODES_INBOX: "op@op.com",
      AUTOBROWSE_ACCOUNTS: "[]",
      WALLET_FILE: "/op/wallet.sealed",
      PROFILES_DIR: "/op/profiles",
      ENV_FILE: "/op/.env",
    };
    const kept: Record<string, string> = {
      PATH: "/usr/bin",
      HOME: "/Users/op",
      USER: "op",
      LOGNAME: "op",
      PWD: "/repo",
      OLDPWD: "/",
      LANG: "en_US.UTF-8",
      SHELL: "/bin/zsh",
      UI_PORT: "9080",
      RESTATE_PORT: "9081",
      LOG_LEVEL: "info",
      AWS_PROFILE: "op",
      AWS_SESSION_TOKEN: "op",
      EXA_API_KEY: "op",
      LANGFUSE_SECRET_KEY: "op",
      ANTHROPIC_API_KEY: "op",
      SHOTS_BUCKET: "op",
    };
    const env: NodeJS.ProcessEnv = {
      AUTOBROWSE_OWNER: "acme",
      OWNERS_DIR: ownersDir({ acme: "" }),
      ...dropped,
      ...kept,
    };
    enterOwner(env);
    expect(Object.keys(env).filter((k) => k in dropped)).toEqual([]);
    for (const [k, v] of Object.entries(kept)) expect(env[k], k).toBe(v);
  });
});

describe("an owner's phone", () => {
  it("never reads the Mac's own Messages, even when its env names them", () => {
    for (const db of [DEFAULT_DB, `${dirname(DEFAULT_DB)}/./chat.db`]) {
      const env = {
        ...INGRESS,
        AUTOBROWSE_OWNER: "acme",
        OWNERS_DIR: ownersDir(),
        PHONE_NUMBER: "+15550000000",
        PHONE_MESSAGES_DB: db,
      };
      const err = thrown(() => loadSettings(env));
      if (err) {
        expect(err.message, db).toMatch(/PHONE_MESSAGES_DB/);
        continue;
      }
      const reads = phoneFor(loadSettings(env))?.dbPath ?? DEFAULT_DB;
      expect(join(reads), db).not.toBe(DEFAULT_DB);
    }
  });
});

describe("names that only look valid", () => {
  const bad = [
    "acme\n",
    "\nacme",
    " acme",
    "acme ",
    "acme\t",
    "Acme",
    "ACME",
    "ácme",
    "аcme",
    "acme-co",
    "acme.co",
    "1acme",
    "_acme",
    "a".repeat(41),
    "a/b",
    "..",
    "acme\u0000",
    "wren\n",
    "Wren",
  ];

  it("every place an owner's name lands refuses them", () => {
    for (const name of [...bad, ""]) {
      const n = JSON.stringify(name);
      expect(() => checkOwner(name), n).toThrow();
      expect(() => named("sites", name), n).toThrow();
      expect(() => ownerKeys(name), n).toThrow();
      expect(() => keychainOf(name), n).toThrow();
      expect(() => ownerDir("/owners", name), n).toThrow();
      expect(
        () => awsConfig({ owner: name, ownerRoleArn: ROLE, region: "us-east-1" }),
        n,
      ).toThrow();
    }
    // In the env, empty is unset (the default owner); anything else must be refused.
    for (const name of bad) {
      const n = JSON.stringify(name);
      expect(() => enterOwner({ AUTOBROWSE_OWNER: name, OWNERS_DIR: "/nonexistent" }), n).toThrow();
      expect(
        () => loadSettings({ ...INGRESS, AUTOBROWSE_OWNER: name, OWNERS_DIR: "/nonexistent" }),
        n,
      ).toThrow();
      expect(
        () => awsConfigFromEnv({ AUTOBROWSE_OWNER: name, AUTOBROWSE_OWNER_ROLE_ARN: ROLE }),
        n,
      ).toThrow();
    }
    for (const name of ["a", "a".repeat(40), "a_b", "a1", "wallet"]) {
      expect(() => ownerDir("/owners", name)).not.toThrow();
      expect(keychainOf(name).service).toBe(`autobrowse-owner-${name}`);
    }
  });

  it("no two owners share a Restate name, prefix, Keychain item or directory", () => {
    const owners = [
      "wren",
      "a",
      "ab",
      "a_b",
      "b",
      "b_a",
      "wallet",
      "config",
      "owners",
      "operator",
      "inputs",
      "owner",
      "owner_wallet",
    ];
    const bases = ["Runs", "browser", "sites", "do", "desk", "Compiled", "domain", "bootstrap"];
    const restate = owners.flatMap((o) => bases.map((b) => named(b, o)));
    expect(new Set(restate).size).toBe(restate.length);

    const keychains = owners.map((o) => keychainOf(o).service);
    expect(new Set([...keychains, WALLET_KEYCHAIN.service]).size).toBe(owners.length + 1);
    expect(keychains.filter((k) => k === KEYCHAIN.service)).toEqual([KEYCHAIN.service]);

    const others = owners.filter((o) => o !== "wren");
    const dirs = others.map((o) => ownerDir("/owners", o));
    expect(new Set(dirs).size).toBe(dirs.length);

    const wren = ownerKeys("wren");
    for (const x of others) {
      const kx = ownerKeys(x);
      expect(kx.ssm.startsWith("/autobrowse/owners/")).toBe(true);
      expect(kx.shots.startsWith("owners/")).toBe(true);
      expect(kx.inputs.startsWith("inputs/owners/")).toBe(true);
      expect(`${kx.ssm}/`.startsWith(`${wren.ssm}/`)).toBe(false);
      expect(`${wren.ssm}/`.startsWith(`${kx.ssm}/`)).toBe(false);
      for (const y of others) {
        if (x === y) continue;
        const ky = ownerKeys(y);
        // `a` must never reach into `ab`, nor `a` into `a_b`.
        expect(`${ky.ssm}/`.startsWith(`${kx.ssm}/`), `${x} ssm into ${y}`).toBe(false);
        expect(ky.shots.startsWith(kx.shots), `${x} shots into ${y}`).toBe(false);
        expect(ky.inputs.startsWith(kx.inputs), `${x} inputs into ${y}`).toBe(false);
      }
    }
  });
});

describe("AWS sessions", () => {
  const at = (owner: string, region = "us-east-1", ownerRoleArn = ROLE) =>
    awsConfig({ owner, ownerRoleArn, region });

  it("never cross owners, regions or roles; the default owner ignores the role", () => {
    const acme = at("acme").credentials;
    expect(acme).toBeDefined();
    expect(at("acme").credentials).toBe(acme);
    expect(at("bob").credentials).not.toBe(acme);
    expect(at("acme", "eu-west-1").credentials).not.toBe(acme);
    expect(at("acme", "us-east-1", `${ROLE}-2`).credentials).not.toBe(acme);
    expect(at("wren")).toEqual({ region: "us-east-1" });
    for (const ownerRoleArn of [undefined, ""])
      expect(() => awsConfig({ owner: "acme", ownerRoleArn, region: "us-east-1" })).toThrow(
        /AUTOBROWSE_OWNER_ROLE_ARN/,
      );
  });

  it("the env path fails closed the same way and shares the owner's session", () => {
    expect(() => awsConfigFromEnv({ AUTOBROWSE_OWNER: "acme" })).toThrow(
      /AUTOBROWSE_OWNER_ROLE_ARN/,
    );
    expect(
      awsConfigFromEnv({ AUTOBROWSE_OWNER: "acme", AUTOBROWSE_OWNER_ROLE_ARN: ROLE }).credentials,
    ).toBe(at("acme").credentials);
    expect(awsConfigFromEnv({})).toEqual({ region: "us-east-1" });
  });

  it("awsFor keeps the owner's session when the region is overridden", () => {
    const s = loadSettings({
      ...INGRESS,
      AUTOBROWSE_OWNER: "acme",
      OWNERS_DIR: ownersDir(),
      AUTOBROWSE_OWNER_ROLE_ARN: ROLE,
    });
    const eu = awsFor(s, "eu-west-1");
    expect(eu.region).toBe("eu-west-1");
    expect(eu.credentials).toBe(at("acme", "eu-west-1").credentials);
    expect(awsFor(loadSettings(INGRESS), "eu-west-1")).toEqual({ region: "eu-west-1" });
  });
});

describe("ownerFromArgv", () => {
  const argv = (...a: string[]) => ["node", "cli", ...a];

  it("reads only the flag itself, first one wins, and a flag-shaped value is refused later", () => {
    expect(ownerFromArgv(["--owner", "acme"])).toBeUndefined();
    expect(ownerFromArgv(argv("--owner"))).toBeUndefined();
    expect(ownerFromArgv(argv("--owner="))).toBe("");
    expect(ownerFromArgv(argv("--owner", "a", "--owner", "b"))).toBe("a");
    expect(ownerFromArgv(argv("--ownerx", "acme"))).toBeUndefined();
    expect(ownerFromArgv(argv("--owner-name=acme"))).toBeUndefined();
    expect(ownerFromArgv(argv("-o", "acme"))).toBeUndefined();
    expect(ownerFromArgv(argv("--owner=a=b"))).toBe("a=b");
    expect(ownerFromArgv(argv("do", "--", "--owner", "acme"))).toBeUndefined();
    const v = ownerFromArgv(argv("--owner", "--help"));
    expect(v).toBe("--help");
    expect(() => checkOwner(v as string)).toThrow();
  });
});

describe("access keys", () => {
  it("a key opens its own owner's worker only", async () => {
    const dir = ownersDir();
    const settingsOf = (owner: string) =>
      loadSettings({ ...INGRESS, AUTOBROWSE_OWNER: owner, OWNERS_DIR: dir });
    const acme = settingsOf("acme");
    const bob = settingsOf("bob");
    expect(acme.accessFile).not.toBe(bob.accessFile);
    expect(expandHome(loadSettings(INGRESS).accessFile)).not.toBe(expandHome(acme.accessFile));

    const acmeKeys = fileKeys(expandHome(acme.accessFile));
    const bobKeys = fileKeys(expandHome(bob.accessFile));
    const rules = { sites: ["github@*"], workflows: ["*"], tools: [], can: ["sites" as const] };
    const { key } = acmeKeys.add("agent", rules);
    const bobs = bobKeys.add("agent", rules).key;
    expect(acmeKeys.resolve(key)).toMatchObject({ operator: false, name: "agent" });
    expect(bobKeys.resolve(key)).toBeNull();
    expect(acmeKeys.resolve(bobs)).toBeNull();

    const worker = (keys: KeyStore) =>
      new Hono<{ Variables: { scope: Scope } }>()
        .use(accessAuth("op-token", keys))
        .get("/who", (c) => c.text(c.get("scope").name));
    const ask = (keys: KeyStore, bearer: string) =>
      worker(keys).request("/who", { headers: { authorization: `Bearer ${bearer}` } });
    expect((await ask(bobKeys, key)).status).toBe(401);
    expect((await ask(acmeKeys, bobs)).status).toBe(401);
    expect(await (await ask(acmeKeys, key)).text()).toBe("agent");
    // The operator's token opens every owner's worker, by design.
    expect(await (await ask(bobKeys, "op-token")).text()).toBe("operator");
  });
});

describe("needs", () => {
  it("done marks stay with their owner", () => {
    const dir = ownersDir();
    const settingsOf = (owner: string) =>
      loadSettings({ ...INGRESS, AUTOBROWSE_OWNER: owner, OWNERS_DIR: dir });
    const acme = fileDone(settingsOf("acme").needsDoneFile);
    const bob = fileDone(settingsOf("bob").needsDoneFile);
    acme.mark("instantly-key", "acme's own");
    expect(Object.keys(acme.read())).toEqual(["instantly-key"]);
    expect(bob.read()).toEqual({});
    expect(expandHome(loadSettings(INGRESS).needsDoneFile)).not.toBe(
      expandHome(settingsOf("acme").needsDoneFile),
    );
  });

  it("an owner's commands carry its flag exactly once", () => {
    const how = "autobrowse needs done x; then pnpm autobrowse creds paste github";
    const once = commandFor(how, "acme");
    expect(once).toBe(
      "autobrowse --owner acme needs done x; then pnpm autobrowse --owner acme creds paste github",
    );
    expect(commandFor(once, "acme")).toBe(once);
    expect(commandFor(how, "wren")).toBe(how);
    expect(commandFor(how, undefined)).toBe(how);
  });
});

describe("an owner's SSM", () => {
  it("reads and writes under its own path only; a name cannot climb out", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const ssm = {
      send: async (command: { input: Record<string, unknown> }) => {
        sent.push(command.input);
        return { Parameters: [] };
      },
    } as unknown as SSMClient;
    const s = loadSettings({
      ...INGRESS,
      AUTOBROWSE_OWNER: "acme",
      OWNERS_DIR: ownersDir(),
      AUTOBROWSE_OWNER_ROLE_ARN: ROLE,
    });
    const store = envStoreFor(s, ssm);
    await store.list();
    await store.put("GITHUB_TOKEN", "acme-gh");
    await store.getMany(["GITHUB_TOKEN"]);
    await expect(store.put("../../config/GITHUB_TOKEN", "x")).rejects.toThrow(/bad name/);
    await expect(store.get("config/GITHUB_TOKEN")).rejects.toThrow(/bad name/);

    const prefix = "/autobrowse/owners/acme/config";
    const touched = sent.flatMap((i) => [
      ...((i.ParameterFilters as Array<{ Values?: string[] }> | undefined)?.flatMap(
        (f) => f.Values ?? [],
      ) ?? []),
      ...(typeof i.Name === "string" ? [i.Name] : []),
      ...((i.Names as string[] | undefined) ?? []),
    ]);
    expect(touched.length).toBeGreaterThanOrEqual(3);
    for (const p of touched) expect(p === prefix || p.startsWith(`${prefix}/`), p).toBe(true);
  });
});

describe("shots", () => {
  beforeEach(() => {
    puts.length = 0;
  });

  it("an owner's shots ship under its own prefix, never another's files", async () => {
    const dir = ownersDir();
    const art = join(dir, "acme", "artifacts");
    const bobArt = join(dir, "bob", "artifacts");
    mkdirSync(join(art, "run1"), { recursive: true });
    mkdirSync(bobArt, { recursive: true });
    writeFileSync(join(art, "run1", "x.png"), "png");
    writeFileSync(join(art, "run1", "x.aria.txt"), "aria");
    writeFileSync(join(art, "run1", "trace.zip"), "trace");
    writeFileSync(join(bobArt, "secret.png"), "bob");
    symlinkSync(bobArt, join(art, "bob-dir"));
    symlinkSync(join(bobArt, "secret.png"), join(art, "bob.png"));
    const s = loadSettings({
      ...INGRESS,
      AUTOBROWSE_OWNER: "acme",
      OWNERS_DIR: dir,
      AUTOBROWSE_OWNER_ROLE_ARN: ROLE,
      SHOTS_BUCKET: "shots",
      SHOTS_MACHINE: "m1",
    });
    const report = await shipperFor(s)?.();
    expect(report?.shipped).toBe(2);
    expect(puts.map((p) => p.Key).sort()).toEqual([
      "owners/acme/m1/artifacts/run1/x.aria.txt",
      "owners/acme/m1/artifacts/run1/x.png",
    ]);
    expect(puts.every((p) => p.Bucket === "shots")).toBe(true);
  });

  it("the default owner's shots keep their legacy keys, outside every owner's prefix", async () => {
    const root = mkdtempSync(join(tmpdir(), "shots-adv-"));
    mkdirSync(join(root, "artifacts"), { recursive: true });
    writeFileSync(join(root, "artifacts", "y.png"), "png");
    const s = loadSettings({
      ...INGRESS,
      ARTIFACTS_DIR: join(root, "artifacts"),
      RECORDINGS_DIR: join(root, "recordings"),
      SHOTS_BUCKET: "shots",
      SHOTS_MACHINE: "box",
    });
    await shipperFor(s)?.();
    expect(puts.map((p) => p.Key)).toEqual(["box/artifacts/y.png"]);
  });
});
