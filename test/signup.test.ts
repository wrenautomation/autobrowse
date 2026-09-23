import { memoryCredentials } from "credvault";
import { describe, expect, it } from "vitest";
import { exploreWithAgent } from "../src/agent/explorer.js";
import type { CodeSource } from "../src/auth/codes.js";
import {
  codeSecrets,
  localPhone,
  loginSecrets,
  mintCredential,
  mintPassword,
  signupGoal,
  signupHosts,
  signupSecrets,
} from "../src/auth/signup.js";
import type { ExploreCommand, Explorer } from "../src/explore/server.js";
import { fakeLlm } from "../src/llm/fake.js";

const cred = {
  username: "hello@wren.test",
  password: "Minted-1!",
  recoveryCodes: [],
  passkeys: [],
};

/** A code source that answers email codes, one per call, with its `since`. */
function codes(answers: string[]): CodeSource & { asked: Date[] } {
  const asked: Date[] = [];
  return {
    asked,
    offers: (kind) => kind === "email",
    inbox: () => "hello@wren.test",
    async get(req) {
      asked.push(req.since);
      return answers.shift() ?? null;
    },
  };
}

describe("signup", () => {
  it("mints the password and stores the credential first; never over an existing one", async () => {
    const store = memoryCredentials();
    const c = await mintCredential(store, { site: "x", email: "hello@wren.test" });
    expect(c.username).toBe("hello@wren.test");
    expect(c.password?.length).toBe(24);
    expect(c.codesInbox).toBe("hello@wren.test");
    await expect(mintCredential(store, { site: "x", email: "other@wren.test" })).rejects.toThrow(
      /already has a stored credential/,
    );
    expect((await store.get("x"))?.username).toBe("hello@wren.test");
    // The same address again is the stalled attempt resuming: same password, nothing re-minted.
    const again = await mintCredential(store, { site: "x", email: "Hello@wren.test" });
    expect(again.password).toBe(c.password);
    const aliased = await mintCredential(store, {
      site: "y",
      email: "hello@wren.test",
      inbox: "will@wren.test",
    });
    expect(aliased.codesInbox).toBe("will@wren.test");
  });

  it("fits the password to a site's cap; a stalled one that does not fit is replaced", async () => {
    const store = memoryCredentials({
      tiktok: { username: "hello@wren.test", password: "x".repeat(24) },
    });
    const c = await mintCredential(store, { site: "tiktok", email: "hello@wren.test" });
    expect(c.password?.length).toBe(20);
    // Made with it: it stands, whatever its length.
    await store.put("tiktok", { ...c, password: "y".repeat(24), madeAt: "2026-09-22T00:00:00Z" });
    const made = await mintCredential(store, { site: "tiktok", email: "hello@wren.test" });
    expect(made.password).toBe("y".repeat(24));
  });

  it("mints a password only on the named account, only where none was set", async () => {
    const store = memoryCredentials({
      li: { username: "me@personal.test", via: "google" },
      "li@wren": { username: "hello@wren.test", via: "google" },
      mine: { username: "hello@wren.test", password: "theirs" },
    });
    const { name, cred } = await mintPassword(store, "li", "Hello@wren.test");
    expect(name).toBe("li@wren");
    expect(cred.password?.length).toBe(24);
    // The other account at the same site is untouched.
    expect((await store.get("li"))?.password).toBeUndefined();
    // A reset that stalled after storing: the same password stands.
    expect((await mintPassword(store, "li", "hello@wren.test")).cred.password).toBe(cred.password);
    await expect(mintPassword(store, "mine", "hello@wren.test")).rejects.toThrow(/creds rotate/);
    expect((await store.get("mine"))?.password).toBe("theirs");
    await expect(mintPassword(store, "li", "nobody@wren.test")).rejects.toThrow(/no li credential/);
  });

  it("secrets by name: email, password, phone, and a fresh code each time", async () => {
    const src = codes(["111111", "222222"]);
    const t0 = new Date("2026-09-21T10:00:00Z");
    let now = t0;
    const s = signupSecrets({ cred, codes: src, since: t0, phone: "+15550001111", now: () => now });
    expect(await s("email")).toBe("hello@wren.test");
    expect(await s("password")).toBe("Minted-1!");
    expect(await s("phone")).toBe("+15550001111");
    expect(await s("phoneLocal")).toBe("5550001111");
    expect(await s("nothing")).toBeNull();
    now = new Date("2026-09-21T10:01:00Z");
    expect(await s("code")).toBe("111111");
    expect(await s("code")).toBe("222222");
    // The second ask only wants codes newer than the first answer.
    expect(src.asked[0]).toEqual(t0);
    expect(src.asked[1]).toEqual(now);
    expect(await s("code")).toBeNull();
  });

  it("the goal names the secrets and the details, never a value", () => {
    const g = signupGoal({
      site: "instagram",
      email: "hello@wren.test",
      name: "Wren Automation",
      handle: "wrenautomation",
    });
    expect(g).toContain('place{secret:"password"}');
    expect(g).toContain('handle "wrenautomation"');
    expect(g).not.toContain("hello@wren.test");
    const withPhone = signupGoal({ site: "tiktok", email: "hello@wren.test" }, "+15875550100");
    expect(withPhone).toContain('place{secret:"phoneLocal"}');
    expect(withPhone).toContain("+1 (Canada or United States)");
    expect(withPhone).not.toContain("5875550100");
    expect(localPhone("+15875550100")).toBe("5875550100");
    expect(localPhone("+447700900123")).toBe("447700900123");
  });

  it("the agent places a secret by name; the value never enters its prompt", async () => {
    const calls: ExploreCommand[] = [];
    const ex: Explorer = {
      port: 0,
      token: "t",
      paused: () => false,
      resumed: async () => {},
      done: Promise.resolve(),
      async exec(c) {
        calls.push(c);
        if (c.cmd === "url") return { url: "https://site.test/join" };
        if (c.cmd === "aria") return { aria: '- textbox "Password"\n- button "Next"' };
        if (c.cmd === "place") return { ok: true, secret: c.secret };
        return { ok: true };
      },
    };
    const llm = fakeLlm([
      {
        thought: "password field",
        action: { cmd: "place", ref: 1, secret: "password", goal: "set the password" },
      },
      { thought: "done", action: { cmd: "done", summary: "placed", achieved: true } },
    ]);
    const r = await exploreWithAgent({
      explorer: ex,
      llm,
      goal: "sign up",
      secrets: ["email", "password", "code"],
    });
    expect(r.achieved).toBe(true);
    expect(calls.find((c) => c.cmd === "place")).toMatchObject({
      secret: "password",
      hints: { role: "textbox", name: "Password" },
    });
    expect(llm.requests[0]?.prompt).toContain("SECRETS (use place): email, password, code");
    expect(llm.requests[1]?.prompt).toContain("1. place [1] secret password");
    expect(JSON.stringify(llm.requests)).not.toContain("Minted");
  });
});

describe("loginSecrets", () => {
  it("another site's stored login, placed only on that site's hosts", async () => {
    const store = memoryCredentials();
    await store.put("instagram", { username: "wren", password: "ig-pw" });
    const l = loginSecrets(store, ["instagram"], {
      secrets: async (n) => (n === "code" ? "12345" : null),
      hosts: (h) => h.includes("facebook"),
    });
    expect(await l.secrets("instagram.password")).toBe("ig-pw");
    expect(await l.secrets("instagram.username")).toBe("wren");
    expect(await l.secrets("code")).toBe("12345");
    expect(await l.secrets("tiktok.password")).toBeNull();
    expect(l.hosts("www.instagram.com", "instagram.password")).toBe(true);
    expect(l.hosts("business.facebook.com", "instagram.password")).toBe(false);
    expect(l.hosts("business.facebook.com", "code")).toBe(true);
    expect(l.hosts("www.instagram.com", "code")).toBe(false);
    // No code source: .code is not available.
    expect(await l.secrets("instagram.code")).toBeNull();
  });

  it("<site>.code: the newest code that login's own inbox got after the session opened", async () => {
    const store = memoryCredentials();
    await store.put("instagram", { username: "wren", password: "p", codesInbox: "ig@wren.test" });
    const asked: string[] = [];
    const source: CodeSource = {
      get: async (_q, cred) => {
        asked.push(cred.codesInbox ?? "");
        return "654321";
      },
      offers: (kind) => kind === "email",
      inbox: () => null,
    };
    const l = loginSecrets(store, ["instagram"], undefined, { source, since: new Date(0) });
    expect(await l.secrets("instagram.code")).toBe("654321");
    expect(asked[0]).toBe("ig@wren.test");
  });
});

describe("signupHosts", () => {
  it("binds placed secrets to hosts carrying the site's name or the signup URL's host", () => {
    const hosts = signupHosts("instagram@wren", "https://accounts.example.com/signup?x=1");
    expect(hosts("www.instagram.com")).toBe(true);
    expect(hosts("accounts.example.com")).toBe(true);
    expect(hosts("instagram.evil.net")).toBe(true); // name-carrying: the agent's own click, not a redirect
    expect(hosts("evil.net")).toBe(false);
    expect(signupHosts("x")("x.com")).toBe(true);
    expect(signupHosts("x")("google.com")).toBe(false);
  });
});

describe("codeSecrets", () => {
  it("places only `code`, read from the inbox, each newer than the last", async () => {
    const src = codes(["111111", "222222"]);
    const s = codeSecrets(src, "hello@wren.test", new Date("2026-09-21T10:00:00Z"));
    expect(await s("email")).toBeNull();
    expect(await s("code")).toBe("111111");
    expect(await s("code")).toBe("222222");
    expect(src.asked[1]?.getTime()).toBeGreaterThan(src.asked[0]?.getTime() ?? 0);
  });
});
