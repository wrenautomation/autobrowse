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
    expect(needs.map((n) => n.name)).toContain("google-admin");
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
      "", // google-admin skipped
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
    const out = await runSetup(io, store, SITE_LOGINS);
    expect(out.stored).toEqual(["google", "cloudflare"]);
    expect(out.skipped).toEqual([
      "google-admin",
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
    ]);
    expect((await store.get("cloudflare"))?.via).toBe("google");
    expect(asked.filter((q) => q.startsWith("hidden")).length).toBe(2);
  });
  it("does not ask again for what is stored", async () => {
    const store = memoryCredentials({
      google: { username: "a", password: "b" },
      cloudflare: { username: "-", password: "-", via: "google" },
      "google-admin": { username: "e", password: "f" },
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
    });
    const { io, asked, said } = scripted([]);
    await runSetup(io, store, SITE_LOGINS);
    expect(asked).toEqual([]);
    expect(said.filter((l) => l.endsWith(": stored")).length).toBe(16);
  });
});
