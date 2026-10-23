import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import type { SignInContext } from "../src/auth/login.js";
import type { FlowPage } from "../src/browser/flow.js";
import type { Hints } from "../src/browser/locate.js";
import { NeedsHuman } from "../src/browser/session.js";
import { walkLogin, walkLogins } from "../src/walks/login.js";
import { saveWalk, type WalkOp, type WalkSpec } from "../src/walks/spec.js";

const PAGES: Record<string, { url: string; landmarks: string[]; go?: Record<string, string> }> = {
  sso: {
    url: "https://sso.lms.test/ls",
    landmarks: ["heading Sign in"],
    go: { "click Sign in": "duo" },
  },
  duo: {
    url: "https://sso.lms.test/duo",
    landmarks: ["heading Enter your passcode"],
    go: { "click Verify": "home" },
  },
  home: { url: "https://lms.test/d2l/home", landmarks: ["heading My courses"] },
};

function fake(first: string) {
  let cur = PAGES[first] as (typeof PAGES)[string];
  const typed: string[] = [];
  let signedIn = false;
  const page = {
    url: () => cur.url,
    evaluate: async () => cur.landmarks,
    isClosed: () => false,
  } as unknown as Page;
  const fp = {
    page,
    url: () => cur.url,
    // Home before the sign-in sends the page to the SSO host, as a real site does.
    async open(url: string) {
      const to = Object.values(PAGES).find((p) => p.url === url) ?? { url, landmarks: [] };
      cur = to === PAGES.home && !signedIn ? (PAGES.sso as (typeof PAGES)[string]) : to;
    },
    async act(op: { kind: string; value?: string }, h: Hints) {
      if (op.kind === "fill") typed.push(`${h.name}=${op.value}`);
      const next = cur.go?.[`${op.kind} ${h.name}`];
      if (next) cur = PAGES[next] as (typeof PAGES)[string];
      if (next === "home") signedIn = true;
    },
    wait: async () => {},
    human(reason: string): never {
      throw new NeedsHuman(reason);
    },
  } as unknown as FlowPage;
  return { fp, typed };
}

const fill = (name: string, key: string): WalkOp => ({
  kind: "fill",
  goal: `fill ${name}`,
  hints: { role: "textbox", name },
  value: { from: "secret", key },
});
const click = (name: string): WalkOp => ({
  kind: "click",
  goal: `click ${name}`,
  hints: { role: "button", name },
  irreversible: false,
});
const spec: WalkSpec = {
  version: 2,
  site: "lms",
  name: "login",
  goal: "sign in to lms",
  built: "2026-10-23T12:00:00.000Z",
  from: [],
  start: "https://lms.test/d2l/home",
  fields: [],
  secrets: [
    { key: "lms.username", label: "User" },
    { key: "lms.password", label: "Password" },
    { key: "passcode", label: "Passcode" },
  ],
  irreversible: false,
  screens: [
    {
      name: "home",
      looks: "my courses",
      url: "lms.test/d2l/home",
      landmarks: ["heading my courses"],
      ops: [],
      goal: true,
      seen: 1,
    },
    {
      name: "sign-in",
      looks: "sign in",
      url: "sso.lms.test/ls",
      landmarks: ["heading sign in"],
      ops: [fill("User", "lms.username"), fill("Password", "lms.password"), click("Sign in")],
      seen: 1,
    },
    {
      name: "passcode",
      looks: "passcode",
      url: "sso.lms.test/duo",
      landmarks: ["heading enter your passcode"],
      ops: [fill("Passcode", "passcode"), click("Verify")],
      seen: 1,
    },
  ],
};

describe("a sign-in walk as a SiteLogin", () => {
  it("signs in with the credential and the texted code, and knows the page it lands on", async () => {
    const login = walkLogin(spec, { code: "sms", credential: "uw" });
    expect(login).toMatchObject({ site: "lms", home: spec.start, credential: "uw" });
    const { fp, typed } = fake("sso");
    expect(await login.loggedIn(fp)).toBe(false);
    const asked: string[] = [];
    const ctx = {
      fp,
      cred: { site: "uw", username: "user-a", password: "pw-a" },
      code: async (kind: string) => {
        asked.push(kind);
        return "123456";
      },
      offers: () => true,
      serial: async (kind: string, fn: () => Promise<unknown>) => {
        asked.push(`lock ${kind}`);
        return fn();
      },
    } as unknown as SignInContext;
    await login.signIn(ctx);
    expect(typed).toEqual(["User=user-a", "Password=pw-a", "Passcode=123456"]);
    expect(asked).toEqual(["lock sms", "sms"]);
    expect(await login.loggedIn(fp)).toBe(true);
  });

  it("names the credential its secrets name, when not given", () => {
    expect(walkLogin(spec).credential).toBe("lms");
  });

  it("needs a start", () => {
    expect(() => walkLogin({ ...spec, start: null })).toThrow(/needs a start/);
  });

  it("finds each site's login walk; a broken file is no login", () => {
    const dir = mkdtempSync(join(tmpdir(), "walk-logins-"));
    try {
      saveWalk(dir, spec);
      mkdirSync(join(dir, "other"));
      writeFileSync(join(dir, "other", "login.json"), "{");
      mkdirSync(join(dir, "nologin"));
      expect(walkLogins(dir).map((l) => [l.site, l.credential, l.home])).toEqual([
        ["lms", "lms", "https://lms.test/d2l/home"],
      ]);
      expect(walkLogins(join(dir, "none"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
