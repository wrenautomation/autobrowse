import { memoryCredentials } from "credvault";
import { describe, expect, it } from "vitest";
import { needsFor, type Prompter, runSetup } from "../src/app/setup.js";
import { SITE_LOGINS } from "../src/auth/sites.js";

function scripted(answers: string[]) {
  const said: string[] = [];
  const asked: string[] = [];
  const io: Prompter = {
    async ask(q) {
      asked.push(q);
      return answers.shift() ?? "";
    },
    async askHidden(q) {
      asked.push(`hidden ${q}`);
      return answers.shift() ?? "";
    },
    say: (l) => said.push(l),
  };
  return { io, said, asked };
}

describe("setup", () => {
  it("needs one google credential for every site behind it, providers first", () => {
    const needs = needsFor(SITE_LOGINS);
    expect(needs[0]?.name).toBe("google");
    expect(needs[0]?.sites).toContain("google");
    expect(needs.map((n) => n.name)).toContain("google@admin");
    expect(needs.find((n) => n.name === "cloudflare")?.viaChoices).toEqual(["google"]);
  });
  it("stores a via credential without asking for a password, skips what is left empty", async () => {
    const store = memoryCredentials();
    const { io, asked } = scripted([
      "admin@x.co",
      "pw",
      "", // google
      "y",
      "admin@x.co", // cloudflare via google
      "", // google@admin skipped
      "", // instantly skipped
      "", // aws skipped
      "", // anthropic skipped
      "", // twilio skipped
      "", // sentry skipped
      "", // linkedin skipped
      "", // instagram skipped
      "", // facebook skipped
      "", // x skipped
      "", // tiktok skipped
      "", // microsoft skipped
    ]);
    const out = await runSetup(io, store, SITE_LOGINS, {
      tier: 1,
      all: true,
      set: { llm: true, codesInbox: true },
    });
    expect(out.stored).toEqual(["google", "cloudflare"]);
    expect(out.skipped).toEqual([
      "google@admin",
      "instantly",
      "aws",
      "anthropic",
      "twilio",
      "sentry",
      "linkedin",
      "instagram",
      "facebook",
      "x",
      "tiktok",
      "microsoft",
      "npm",
      "github",
      "reddit",
      "perplexity",
      "discord",
      "hubspot",
      "intuit",
      "outlook@uw",
    ]);
    expect((await store.get("cloudflare"))?.via).toBe("google");
    expect(asked.filter((q) => q.startsWith("hidden")).length).toBe(2);
  });
  it("does not ask again for what is stored", async () => {
    const store = memoryCredentials({
      google: { username: "a", password: "b" },
      cloudflare: { username: "-", password: "-", via: "google" },
      "google@admin": { username: "e", password: "f" },
      instantly: { username: "c", password: "d" },
      aws: { username: "root@x.co", password: "g" },
      anthropic: { username: "-", password: "-", via: "google" },
      twilio: { username: "-", password: "-", via: "google" },
      sentry: { username: "-", password: "-", via: "google" },
      linkedin: { username: "w@x.com", password: "h" },
      instagram: { username: "wren", password: "i" },
      facebook: { username: "w@x.com", password: "f" },
      x: { username: "wren", password: "x" },
      tiktok: { username: "wren", password: "t" },
      microsoft: { username: "w@outlook.com", password: "m" },
      npm: { username: "wrenautomation", password: "n" },
      github: { username: "wren", password: "g" },
      reddit: { username: "WrenAutomation", password: "r" },
      perplexity: { username: "w@x.com", password: "-", via: "google" },
      discord: { username: "w@x.com", password: "d" },
      hubspot: { username: "w@x.com", password: "-", via: "google" },
      intuit: { username: "w@x.com", password: "i" },
      "outlook@uw": { username: "w@uwaterloo.ca", password: "u" },
    });
    const { io, asked, said } = scripted([]);
    await runSetup(io, store, SITE_LOGINS, {
      tier: 1,
      all: true,
      set: { llm: true, codesInbox: true },
    });
    expect(asked).toEqual([]);
    expect(said.filter((l) => l.endsWith(": stored")).length).toBe(22);
  });

  function envSink() {
    const put: Record<string, string> = {};
    return {
      put,
      env: {
        put: async (n: string, v: string) => {
          put[n] = v;
        },
      },
    };
  }
  it("tier 0 asks for nothing but the tier", async () => {
    const store = memoryCredentials();
    const { put, env } = envSink();
    const { io, asked, said } = scripted(["0"]);
    const out = await runSetup(io, store, SITE_LOGINS, { env, has: () => true, mac: true });
    expect(asked).toEqual(["Which tier? [0/1/2] (default 0) "]);
    expect(out.stored).toEqual([]);
    expect(put).toEqual({});
    expect(said.at(-1)).toContain("--no-llm");
  });
  it("tier 1 asks for the model and the picked sites only, a provider when a site uses its button", async () => {
    const store = memoryCredentials();
    const { put, env } = envSink();
    const { io, asked } = scripted([
      "", // claude-code: yes
      "github, Cloudflare, nope",
      "y", // cloudflare via google
      "me@x.co",
      "", // github: not via google
      "me@x.co",
      "pw",
      "", // no authenticator
      "", // google: skipped
      "codes@x.co",
      "+1 (555) 123-4567",
    ]);
    const out = await runSetup(io, store, SITE_LOGINS, {
      tier: 1,
      env,
      has: (b) => b === "claude",
      mac: true,
    });
    expect(out.stored).toEqual(["cloudflare", "github"]);
    expect(out.skipped).toEqual(["google"]);
    expect(put).toEqual({
      LLM_PROVIDER: "claude-code",
      CODES_INBOX: "codes@x.co",
      PHONE_NUMBER: "+15551234567",
    });
    expect(asked.some((q) => q.includes("instantly"))).toBe(false);
  });
  it("tier 1 without claude takes an Anthropic key, hidden", async () => {
    const { put, env } = envSink();
    const { io, asked } = scripted(["sk-test", ""]);
    await runSetup(io, memoryCredentials(), SITE_LOGINS, {
      tier: 1,
      env,
      has: () => false,
      set: { codesInbox: true },
    });
    expect(asked[0]?.startsWith("hidden")).toBe(true);
    expect(put).toEqual({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test" });
  });
  it("tier 2 points the worker at a local Restate", async () => {
    const { put, env } = envSink();
    const { io, said } = scripted([""]);
    await runSetup(io, memoryCredentials(), SITE_LOGINS, {
      tier: 2,
      env,
      has: () => false,
      set: { llm: true, codesInbox: true },
    });
    expect(put.RESTATE_ADMIN_URL).toBe("http://localhost:9070");
    expect(put.RESTATE_ENDPOINT_URL).toBe("http://localhost:9081");
    expect(said.some((l) => l.includes("brew install restatedev/tap/restate"))).toBe(true);
  });
});
