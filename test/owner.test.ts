/** Owners (designs/2026-09-30-owner-keys.md): names, the env an owner's process sees, AWS, keys. */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/app/config.js";
import { planEndpoint } from "../src/app/endpoint.js";
import { enterOwner, ownerFromArgv } from "../src/app/owner.js";
import {
  buildApp,
  cardsFor,
  codesFor,
  linqFor,
  ourPhone,
  profilesFor,
  shipperFor,
  walletFor,
} from "../src/app/services.js";
import { KEYCHAIN, keychainOf, WALLET_KEYCHAIN } from "../src/auth/keep.js";
import { makeRunObject } from "../src/engine/object.js";
import { runsRegistryFor } from "../src/engine/registry.js";
import { runFlow } from "../src/engine/run.js";
import { awsConfig, named, ownerKeys } from "../src/owner.js";
import { makeCompiledRunObject } from "../src/workflows/compiled.js";
import { domainWorkflow, parsePlan } from "../src/workflows/domain/index.js";
import { fakeBrowser, fakeDeps, fakeEffects, fakeHost, scriptedAnswers } from "./fakes.js";

const ROLE = "arn:aws:iam::000000000000:role/autobrowse-owners";

function ownersDir(files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "owners-"));
  for (const [owner, text] of Object.entries(files)) {
    mkdirSync(join(dir, owner), { recursive: true });
    writeFileSync(join(dir, owner, ".env"), text);
  }
  return dir;
}

describe("names", () => {
  it("the default owner keeps every legacy name; another gets its own", () => {
    expect(named("sites")).toBe("sites");
    expect(named("sites", "wren")).toBe("sites");
    expect(named("sites", "acme")).toBe("sites_acme");
    expect(ownerKeys("wren")).toEqual({ ssm: "/autobrowse/config", shots: "", inputs: "inputs/" });
    expect(ownerKeys("acme")).toEqual({
      ssm: "/autobrowse/owners/acme/config",
      shots: "owners/acme/",
      inputs: "inputs/owners/acme/",
    });
  });

  it("refuses a name that could climb out of its place", () => {
    for (const bad of ["", "Acme", "a/b", "../x", "a-b", "1abc", "a".repeat(41)]) {
      expect(() => named("sites", bad)).toThrow();
      expect(() => ownerKeys(bad)).toThrow();
    }
  });

  it("an owner's seal key never lands on the wallet's", () => {
    expect(keychainOf("wren")).toBe(KEYCHAIN);
    expect(keychainOf("wallet").service).not.toBe(WALLET_KEYCHAIN.service);
    expect(keychainOf("acme").service).toBe("autobrowse-owner-acme");
  });

  it("Restate objects and services carry the owner; runs keep the workflow's own name", () => {
    const host = { ...fakeHost(), owner: "acme" };
    expect(runsRegistryFor("acme").name).toBe("Runs_acme");
    expect(runsRegistryFor().name).toBe("Runs");
    expect(makeRunObject(domainWorkflow, fakeDeps(), host).name).toBe("domain_acme");
    expect(makeRunObject(domainWorkflow, fakeDeps(), fakeHost()).name).toBe("domain");
    const catalog = { list: async () => [], get: async () => null, proofs: async () => ({}) };
    const browser = fakeBrowser([]);
    expect(makeCompiledRunObject({ catalog, browser, host }).name).toBe("Compiled_acme");
  });

  it("the tunnel is the owner's", () => {
    const tunnel = {
      RESTATE_INGRESS_URL: "http://127.0.0.1:8080",
      RESTATE_TUNNEL_NAME: "autobrowse",
      RESTATE_ENVIRONMENT_ID: "env_1",
      RESTATE_CLOUD_REGION: "us",
      RESTATE_IDENTITY_KEY: "publickeyv1_x",
      RESTATE_AUTH_TOKEN: "t",
    };
    const plan = planEndpoint({ ...loadSettings(tunnel), owner: "acme" });
    expect(plan).toMatchObject({ mode: "tunnel", tunnelName: "autobrowse_acme" });
    expect(planEndpoint(loadSettings(tunnel))).toMatchObject({ tunnelName: "autobrowse" });
  });
});

describe("AWS", () => {
  it("the default owner uses the process's credentials", () => {
    expect(awsConfig({ owner: "wren", region: "us-east-1" })).toEqual({ region: "us-east-1" });
  });

  it("another owner fails closed without the role, and shares one session per role and region", () => {
    expect(() => awsConfig({ owner: "acme", region: "us-east-1" })).toThrow(
      /AUTOBROWSE_OWNER_ROLE_ARN/,
    );
    const a = awsConfig({ owner: "acme", ownerRoleArn: ROLE, region: "us-east-1" });
    expect(typeof a.credentials).toBe("function");
    expect(awsConfig({ owner: "acme", ownerRoleArn: ROLE, region: "us-east-1" }).credentials).toBe(
      a.credentials,
    );
    expect(
      awsConfig({ owner: "beta", ownerRoleArn: ROLE, region: "us-east-1" }).credentials,
    ).not.toBe(a.credentials);
  });

  it("every AWS client in src takes its config from the owner factory", () => {
    const offenders: string[] = [];
    let seen = 0;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts")) {
          const text = readFileSync(path, "utf8");
          for (const m of text.matchAll(/new (\w+)Client\(([^)]*)/g)) {
            const aws = new RegExp(
              `\\b${m[1]}Client\\b[^;]*from "@aws-sdk/|@aws-sdk/client-${(m[1] as string).toLowerCase()}`,
            );
            if (!aws.test(text)) continue;
            seen++;
            if (
              !/\baws(For|Config|ConfigFromEnv)?\b|\.\.\.(o\.)?aws\b|opts\.aws\b/.test(
                m[2] as string,
              )
            )
              offenders.push(`${path}: new ${m[1]}Client(${m[2]}`);
          }
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
    expect(seen).toBeGreaterThan(5);
  });
});

describe("enterOwner", () => {
  const operator = () => ({
    AUTOBROWSE_OWNER: "acme",
    PATH: "/usr/bin",
    HOME: "/Users/op",
    USER: "op",
    AWS_REGION: "us-east-1",
    AWS_PROFILE: "op",
    ANTHROPIC_API_KEY: "op-model",
    EXA_API_KEY: "op-exa",
    LANGFUSE_SECRET_KEY: "op-lf",
    RESTATE_AUTH_TOKEN: "op-restate",
    UI_PORT: "9080",
    CLOUDFLARE_API_TOKEN: "op-cf",
    GOOGLE_SERVICE_ACCOUNT: "/op/sa.json",
    AUTOBROWSE_CRED_GOOGLE: "op-cred",
    AUTOBROWSE_CARD_CVV: "op-cvv",
    GMAIL_REFRESH_TOKEN: "op-gmail",
    BROWSERBASE_CONTEXT_X: "op-ctx",
    INSTANTLY_API_KEY: "op-instantly",
    SOME_SERVICE_PASSWORD: "op-pw",
    CREDENTIALS_FILE: "/op/credentials.json",
    FROM_OPERATOR_FILE: "op-file",
  });

  it("drops the operator's accounts, keeps its tools, adds the owner's", () => {
    const dir = ownersDir({ acme: "CLOUDFLARE_API_TOKEN=acme-cf\nUI_PORT=9180\nACME_ONLY=1\n" });
    const env: NodeJS.ProcessEnv = { ...operator(), OWNERS_DIR: dir };
    expect(enterOwner(env, ["FROM_OPERATOR_FILE"])).toBe("acme");
    // Tools, AWS, the process and the system stay.
    for (const k of [
      "PATH",
      "HOME",
      "USER",
      "AWS_REGION",
      "AWS_PROFILE",
      "ANTHROPIC_API_KEY",
      "EXA_API_KEY",
      "LANGFUSE_SECRET_KEY",
      "RESTATE_AUTH_TOKEN",
    ])
      expect(env[k], k).toBe(operator()[k as keyof ReturnType<typeof operator>]);
    // Accounts go: settings, prefixes, anything shaped like a secret, the operator's file.
    for (const k of [
      "GOOGLE_SERVICE_ACCOUNT",
      "AUTOBROWSE_CRED_GOOGLE",
      "AUTOBROWSE_CARD_CVV",
      "GMAIL_REFRESH_TOKEN",
      "BROWSERBASE_CONTEXT_X",
      "INSTANTLY_API_KEY",
      "SOME_SERVICE_PASSWORD",
      "CREDENTIALS_FILE",
      "FROM_OPERATOR_FILE",
    ])
      expect(env[k], k).toBeUndefined();
    // The owner's own, and a per-process setting it may pick.
    expect(env.CLOUDFLARE_API_TOKEN).toBe("acme-cf");
    expect(env.UI_PORT).toBe("9180");
    expect(env.ACME_ONLY).toBe("1");
  });

  it("the default owner's env is left alone", () => {
    const env: NodeJS.ProcessEnv = { ...operator(), AUTOBROWSE_OWNER: "wren" };
    enterOwner(env, ["FROM_OPERATOR_FILE"]);
    expect(env).toEqual({ ...operator(), AUTOBROWSE_OWNER: "wren" });
  });

  it("an owner's file may not set the operator's things; the error names keys, never values", () => {
    for (const line of [
      "ANTHROPIC_API_KEY=sk-owner-secret",
      "EXA_API_KEY=sk-owner-secret",
      "AWS_ACCESS_KEY_ID=sk-owner-secret",
      "AUTOBROWSE_OWNER=wren",
      "AUTOBROWSE_OWNER_ROLE_ARN=sk-owner-secret",
      "CREDENTIALS_FILE=sk-owner-secret",
      "OWNERS_DIR=sk-owner-secret",
      "RESTATE_AUTH_TOKEN=sk-owner-secret",
    ]) {
      const dir = ownersDir({ acme: `${line}\n` });
      const env: NodeJS.ProcessEnv = { AUTOBROWSE_OWNER: "acme", OWNERS_DIR: dir };
      let message = "";
      try {
        enterOwner(env);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, line).toContain(line.split("=")[0]);
      expect(message).not.toContain("sk-owner-secret");
    }
  });

  it("an owner without a file of its own starts with no accounts", () => {
    const env: NodeJS.ProcessEnv = { ...operator(), OWNERS_DIR: ownersDir() };
    enterOwner(env);
    expect(env.CLOUDFLARE_API_TOKEN).toBeUndefined();
  });
});

describe("an owner's settings", () => {
  it("puts every file under the owner's directory, fixed", () => {
    const dir = ownersDir();
    const s = loadSettings({
      RESTATE_INGRESS_URL: "http://127.0.0.1:8080",
      AUTOBROWSE_OWNER: "acme",
      OWNERS_DIR: dir,
    });
    const home = join(dir, "acme");
    expect(s.credentialsFile).toBe(join(home, "credentials.json"));
    expect(s.accountsFile).toBe(join(home, "accounts.json"));
    expect(s.accessFile).toBe(join(home, "access.json"));
    expect(s.needsDoneFile).toBe(join(home, "needs-done.json"));
    expect(s.profilesDir).toBe(join(home, "profiles"));
    expect(s.recordingsDir).toBe(join(home, "recordings"));
    expect(s.envFile).toBe(join(home, ".env"));
    expect(s.rosterSsmParam).toBe("/autobrowse/owners/acme/roster");
    expect(() =>
      loadSettings({
        RESTATE_INGRESS_URL: "http://127.0.0.1:8080",
        AUTOBROWSE_OWNER: "acme",
        OWNERS_DIR: dir,
        CREDENTIALS_FILE: "/elsewhere.json",
      }),
    ).toThrow(/CREDENTIALS_FILE/);
  });

  it("refuses the live env of a process that never entered the owner", () => {
    const before = process.env.AUTOBROWSE_OWNER;
    process.env.AUTOBROWSE_OWNER = "acme";
    try {
      expect(() => loadSettings()).toThrow(/not entered/);
    } finally {
      if (before === undefined) delete process.env.AUTOBROWSE_OWNER;
      else process.env.AUTOBROWSE_OWNER = before;
    }
  });

  it("keeps its own memory, and its phone reads only the database it names", () => {
    const base = {
      RESTATE_INGRESS_URL: "http://127.0.0.1:8080",
      AUTOBROWSE_OWNER: "acme",
      OWNERS_DIR: ownersDir(),
    };
    expect(loadSettings(base).backboardAssistant).toBe("autobrowse-acme");
    expect(loadSettings({ ...base, BACKBOARD_ASSISTANT: "acme-mem" }).backboardAssistant).toBe(
      "acme-mem",
    );
    expect(loadSettings({ RESTATE_INGRESS_URL: "http://127.0.0.1:8080" }).backboardAssistant).toBe(
      "autobrowse",
    );
    expect(() => loadSettings({ ...base, PHONE_NUMBER: "+15550000000" })).toThrow(
      /PHONE_MESSAGES_DB/,
    );
  });

  it("never signs up with, or reads codes from, the operator's lines", () => {
    const lines = {
      RESTATE_INGRESS_URL: "http://127.0.0.1:8080",
      TWILIO_ACCOUNT_SID: "AC0",
      TWILIO_AUTH_TOKEN: "t",
      TWILIO_NUMBER: "+15550000001",
      LINQ_API_KEY: "k",
      LINQ_NUMBER: "+15550000002",
      PHONE_NUMBER: "+15550000003",
    };
    const operator = loadSettings(lines);
    expect(ourPhone(operator)).toBe("+15550000003");
    expect(linqFor(operator)?.to).toBe("+15550000003");
    const owner = loadSettings({
      ...lines,
      PHONE_NUMBER: "",
      AUTOBROWSE_OWNER: "acme",
      OWNERS_DIR: ownersDir(),
    });
    expect(ourPhone(owner)).toBeNull();
    expect(linqFor(owner)).toBeNull();
    const gmail = { recent: async () => [] } as unknown as Parameters<typeof codesFor>[1];
    const cred = { username: "sam", password: "p", recoveryCodes: [], passkeys: [] };
    expect(codesFor(operator, gmail).offers("sms", cred)).toBe(true);
    // TOTP and the owner's own email only.
    expect(codesFor(owner, gmail).offers("sms", cred)).toBe(false);
  });

  it("has no cards: the wallet is the operator's", async () => {
    const s = loadSettings({
      RESTATE_INGRESS_URL: "http://127.0.0.1:8080",
      AUTOBROWSE_OWNER: "acme",
      OWNERS_DIR: ownersDir(),
    });
    await expect(walletFor(s)).rejects.toThrow(/operator's/);
    await expect(profilesFor(s)).rejects.toThrow(/operator's/);
    expect(cardsFor(s)).toBeUndefined();
  });

  it("ships shots to S3 under its own prefix, never to an unfenced store", () => {
    const base = {
      RESTATE_INGRESS_URL: "http://127.0.0.1:8080",
      AUTOBROWSE_OWNER: "acme",
      OWNERS_DIR: ownersDir(),
      AUTOBROWSE_OWNER_ROLE_ARN: ROLE,
      SHOTS_BUCKET: "shots",
    };
    expect(shipperFor(loadSettings(base))).toBeTypeOf("function");
    expect(() =>
      shipperFor(loadSettings({ ...base, SHOTS_ENDPOINT: "https://r2.example.com" })),
    ).toThrow(/S3 only/);
  });
});

describe("ownerFromArgv", () => {
  const argv = (...a: string[]) => ["node", "cli", ...a];
  it("reads --owner x and --owner=x, and stops at --", () => {
    expect(ownerFromArgv(argv("env", "list", "--owner", "acme"))).toBe("acme");
    expect(ownerFromArgv(argv("--owner=acme", "env", "list"))).toBe("acme");
    expect(ownerFromArgv(argv("env", "list"))).toBeUndefined();
    expect(ownerFromArgv(argv("do", "--", "--owner", "acme"))).toBeUndefined();
  });
});

describe("an owner's worker", () => {
  it("writes the owner's roster and leaves it there: no wren redeploy, no loops", async () => {
    const deps = fakeDeps({ wren: null });
    const { fx } = fakeEffects();
    const { answer } = scriptedAnswers({ purchase: [{}] });
    const plan = parsePlan({
      domain: "acme-new.test",
      inboxes: [{ local: "sam", givenName: "Sam", familyName: "Lee" }],
      signatureHtml: "<b>S</b>",
    });
    const out = await runFlow(fx, domainWorkflow, deps, plan, answer);
    expect(out.status).toBe("done");
    expect(out.results.roster?.detail).toBe("added sam@acme-new.test; no wren for this owner");
    expect(out.results.loops?.status).toBe("skipped");
    expect(deps.calls).toContain("roster write");
    expect(deps.calls.filter((c) => c === "redeploy" || c.startsWith("loops"))).toEqual([]);
  });

  it("names every Restate service and object for its owner", async () => {
    const log = pino({ level: "silent" });
    const names = async (env: Record<string, string>) =>
      (
        await buildApp(loadSettings({ RESTATE_INGRESS_URL: "http://127.0.0.1:8080", ...env }), log)
      ).services
        .map((s) => s.name)
        .sort();
    const wren = await names({});
    expect(wren).toEqual(
      expect.arrayContaining(["Compiled", "Runs", "bootstrap", "browser", "do", "domain", "sites"]),
    );
    const acme = await names({
      AUTOBROWSE_OWNER: "acme",
      OWNERS_DIR: ownersDir(),
      AUTOBROWSE_OWNER_ROLE_ARN: ROLE,
    });
    expect(acme).toEqual(wren.map((n) => `${n}_acme`).sort());
  });
});
