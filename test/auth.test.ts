import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryCredentials, totp } from "credvault";
import { describe, expect, it } from "vitest";
import type { Settings } from "../src/app/config.js";
import { credentialsFor } from "../src/app/services.js";
import {
  type CodeKind,
  codeSources,
  credentialFor,
  extractCode,
  formLogin,
  inboxLock,
  LoginFailed,
  landAfterOauth,
  loginProvider,
  type Message,
  messageSource,
  resolveLogin,
  type SignInContext,
  type SiteLogin,
  signInToGoogle,
  totpSource,
  viaLogin,
} from "../src/auth/index.js";
import type { FlowPage } from "../src/browser/flow.js";
import type { Hints } from "../src/browser/locate.js";
import { NeedsHuman } from "../src/browser/session.js";
import { fakePage } from "./auth-fakes.js";

// RFC 6238 test vector: secret "12345678901234567890" (base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ).
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("autobrowse's names in the vault", () => {
  it("reads credentials from AUTOBROWSE_CRED_* env ahead of the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-creds-"));
    const settings = {
      credentialsCipher: "none",
      credentialsFile: join(dir, "c.json"),
    } as Settings;
    const env = { AUTOBROWSE_CRED_X_USERNAME: "u", AUTOBROWSE_CRED_X_PASSWORD: "p" };
    Object.assign(process.env, env);
    try {
      const store = credentialsFor(settings, { armed: false });
      expect((await store.get("x"))?.username).toBe("u");
      expect(await store.list()).toContain("x");
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  });
});

describe("code sources", () => {
  const cred = { username: "u@x.co", password: "p", totpSecret: RFC_SECRET, recoveryCodes: [] };
  it("extracts the code near the word code", () => {
    expect(extractCode("Your Instantly code is 482913. Expires in 10 minutes (600 seconds).")).toBe(
      "482913",
    );
    expect(extractCode("Order 12345678 shipped")).toBe("12345678");
    expect(extractCode("nothing")).toBeNull();
    expect(extractCode("FB-48291 is your Facebook confirmation code")).toBe("48291");
    expect(extractCode("Your confirmation code: 48291")).toBe("48291");
    expect(extractCode("Welcome, member since 2026")).toBeNull();
  });
  it("totp waits out a code about to expire", async () => {
    const waits: number[] = [];
    let t = 58_000;
    const sleep = async (ms: number) => {
      waits.push(ms);
      t += ms;
    };
    const src = totpSource({ now: () => t, sleep });
    const code = await src.get({ site: "s", kind: "totp", since: new Date(0) }, cred);
    expect(waits).toEqual([2_000]);
    expect(code).toBe(totp(RFC_SECRET, { at: 60_000 }));
    expect(await src.get({ site: "s", kind: "email", since: new Date(0) }, cred)).toBeNull();
  });
  it("email polls until a fresh message with the hint carries a code", async () => {
    const inbox: Message[] = [
      { from: "old@x", subject: "code 111111", text: "", at: new Date(1_000) },
    ];
    let polls = 0;
    const reader = {
      async recent(_inbox: string, since: Date) {
        polls++;
        if (polls === 2)
          inbox.push({
            from: "no-reply@instantly.ai",
            subject: "Your code",
            text: "code: 222222",
            at: new Date(5_000),
          });
        return inbox.filter((m) => m.at >= since);
      },
    };
    let t = 10_000;
    const src = messageSource({
      kind: "email",
      reader,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      pollMs: 1_000,
    });
    const code = await src.get(
      { site: "instantly", kind: "email", since: new Date(2_000), hint: "instantly" },
      cred,
    );
    expect(code).toBe("222222");
    expect(polls).toBe(2);
  });
  it("email gives up at the deadline", async () => {
    let t = 0;
    const src = messageSource({
      kind: "email",
      reader: { recent: async () => [] },
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      pollMs: 1_000,
      timeoutMs: 3_000,
    });
    expect(await src.get({ site: "s", kind: "email", since: new Date(0) }, cred)).toBeNull();
  });
  it("a code typed once is never handed to the next sign-in on the same phone", async () => {
    let t = 0;
    const src = messageSource({
      kind: "sms",
      inbox: "+15555550182",
      reader: {
        recent: async () => [{ from: "Google", subject: "", text: "G-111111", at: new Date(1) }],
      },
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      timeoutMs: 2_000,
    });
    const req = { site: "google", kind: "sms" as const, since: new Date(0) };
    expect(await src.get(req, cred)).toBe("111111");
    expect(await src.get(req, cred)).toBeNull();
  });
  it("asks on one inbox queue: the second waits for the first to let go", async () => {
    const dir = mkdtempSync(join(tmpdir(), "locks-"));
    const order: string[] = [];
    const first = await inboxLock("+15555550182", { dir, pollMs: 5 });
    const second = inboxLock("+1 555 555 0182".replace(/ /g, ""), { dir, pollMs: 5 }).then(
      (release) => {
        order.push("second");
        return release;
      },
    );
    await new Promise((r) => setTimeout(r, 30));
    order.push("first done");
    await first();
    await (await second)();
    expect(order).toEqual(["first done", "second"]);
    // A holder that died long ago is taken over.
    await inboxLock("+15555550182", { dir });
    const again = await inboxLock("+15555550182", { dir, staleMs: -1 });
    await again();
  });
  it("first source with an answer wins", async () => {
    const src = codeSources(
      { get: async () => null, offers: () => false, inbox: () => null },
      { get: async () => "9", offers: () => true, inbox: () => "x" },
    );
    expect(await src.get({ site: "s", kind: "sms", since: new Date(0) }, cred)).toBe("9");
  });
});

/** A page as a script: what `text()` says after each act, and which hints exist. */
const spec = {
  start: "https://site.test/login",
  username: { role: "textbox", name: "Email" },
  password: { role: "textbox", name: "Password" },
  submit: { role: "button", name: "Log in" },
  code: {
    kind: "totp" as const,
    asks: /authenticator/i,
    field: { role: "textbox", name: "Code" },
    submit: { role: "button", name: "Continue" },
  },
  rejected: /incorrect/i,
  success: /dashboard/i,
};

describe("formLogin", () => {
  const cred = { username: "u", password: "p", totpSecret: RFC_SECRET, recoveryCodes: [] };
  it("fills username and password, then the code when asked, and checks success", async () => {
    const { fp, acts } = fakePage({
      text: ["login", "Enter the code from your authenticator", "Dashboard"],
      present: () => true,
    });
    const asked: string[] = [];
    const code = async (k: string) => {
      asked.push(k);
      return "123456";
    };
    await formLogin("s", spec)({ fp, cred, code });
    expect(asked).toEqual(["totp"]);
    expect(acts.map((a) => a.op)).toEqual([
      { kind: "fill", value: "u" },
      { kind: "fill", value: "p" },
      { kind: "click" },
      { kind: "fill", value: "123456" },
      { kind: "click" },
    ]);
  });
  it("stops on a rejected password instead of retrying into a lockout", async () => {
    const { fp } = fakePage({
      text: ["login", "Incorrect email or password"],
      present: () => true,
    });
    await expect(formLogin("s", spec)({ fp, cred, code: async () => "1" })).rejects.toThrow(
      LoginFailed,
    );
  });
  it("answers a key prompt with our passkey, and then asks for no code", async () => {
    const withKey = {
      ...spec,
      passkey: { asks: /security key/i, start: { role: "button", name: "Use security key" } },
    };
    const { fp, acts } = fakePage({
      text: ["login", "Security key: ready to authenticate (2FA)", "Dashboard 2FA banner"],
      present: () => true,
    });
    const asked: string[] = [];
    const passkeys = [
      {
        rpId: "site.test",
        credentialId: "c",
        privateKey: "k",
        signCount: 1,
        isResidentCredential: false,
      },
    ];
    await formLogin("s", { ...withKey, code: { ...spec.code, asks: /2fa/i } })({
      fp,
      cred: { ...cred, passkeys },
      code: async (k) => {
        asked.push(k);
        return "1";
      },
    });
    expect(asked).toEqual([]);
    expect(acts.at(-1)?.hints).toEqual({ role: "button", name: "Use security key" });
  });
  it("fails loudly when the page is still not signed in", async () => {
    const { fp } = fakePage({ text: ["login", "something else"], present: () => true });
    await expect(formLogin("s", spec)({ fp, cred, code: async () => "1" })).rejects.toThrow(
      /still on/,
    );
  });
});

describe("loginProvider", () => {
  const site: SiteLogin = {
    site: "s",
    home: "https://site.test/",
    loggedIn: async () => true,
    async signIn({ code }) {
      await code("totp");
    },
  };
  it("signs in with the stored credential and a code from the sources", async () => {
    const login = loginProvider([site], {
      credentials: memoryCredentials({
        s: { username: "u", password: "p", totpSecret: RFC_SECRET },
      }),
      codes: totpSource(),
    });
    expect(await login(fakePage({ text: [], present: () => true }).fp, "s")).toBe("signed-in");
    expect(await login(fakePage({ text: [], present: () => true }).fp, "other")).toBe(
      "unknown-site",
    );
  });
  it("answers codes for the credential an OAuth sign-in swaps in, not the site's own", async () => {
    const viaGoogle: SiteLogin = {
      site: "s",
      home: "https://site.test/",
      via: ["google"],
      loggedIn: async () => true,
      async signIn(ctx) {
        const sub = ctx.as(await ctx.credFor("google"));
        expect(sub.offers("totp")).toBe(true);
        expect(ctx.offers("totp")).toBe(false);
        await sub.code("totp");
      },
    };
    const login = loginProvider([viaGoogle], {
      credentials: memoryCredentials({
        s: { username: "u", password: "-", via: "google" },
        google: { username: "g", password: "p", totpSecret: RFC_SECRET },
      }),
      codes: totpSource(),
    });
    expect(await login(fakePage({ text: [], present: () => true }).fp, "s")).toBe("signed-in");
  });
  it("hands the provider credential for the account the site names: the stored one, a second `google@ops`, or a clear miss", async () => {
    const seen: string[] = [];
    const viaGoogle: SiteLogin = {
      site: "s",
      home: "https://site.test/",
      via: ["google"],
      loggedIn: async () => true,
      async signIn(ctx) {
        seen.push((await ctx.credFor("google", ctx.cred.username)).password ?? "");
      },
    };
    const store = memoryCredentials({
      s: { username: "Ops@x.com ", via: "google" },
      t: { username: "g@x.com", via: "google" },
      u: { username: "nobody@x.com", via: "google" },
      google: { username: "g@x.com", password: "main" },
      "google@ops": { username: "ops@x.com", password: "second" },
    });
    const login = loginProvider(
      [viaGoogle, { ...viaGoogle, site: "t" }, { ...viaGoogle, site: "u" }],
      {
        credentials: store,
        codes: totpSource(),
      },
    );
    const page = () => fakePage({ text: [], present: () => true }).fp;
    expect(await login(page(), "s")).toBe("signed-in");
    expect(await login(page(), "t")).toBe("signed-in");
    expect(seen).toEqual(["second", "main"]);
    await expect(login(page(), "u")).rejects.toThrow(/no google credential for nobody@x.com/);
  });
  it("one account, several ways in: the password first, the provider when it is refused", async () => {
    const tried: string[] = [];
    let refuse = false;
    const both: SiteLogin = {
      site: "s",
      home: "https://site.test/",
      via: ["google"],
      loggedIn: async () => true,
      async signIn(ctx) {
        tried.push(ctx.cred.via ? `via ${ctx.cred.username}` : `password ${ctx.cred.username}`);
        if (refuse && !ctx.cred.via) throw new LoginFailed("s", "password rejected");
      },
    };
    const login = loginProvider([both], {
      credentials: memoryCredentials({
        s: { username: "handle", password: "p", via: "google", codesInbox: "me@x.com" },
      }),
      codes: totpSource(),
    });
    const page = () => fakePage({ text: [], present: () => true }).fp;
    expect(await login(page(), "s")).toBe("signed-in");
    refuse = true;
    expect(await login(page(), "s")).toBe("signed-in");
    expect(tried).toEqual(["password handle", "password handle", "via me@x.com"]);
    // The provider route finds the account by its address too.
    expect(await login(page(), "s", "me@x.com")).toBe("signed-in");
  });
  it("reports a missing credential and a missing code", async () => {
    const login = loginProvider([site], {
      credentials: memoryCredentials(),
      codes: { get: async () => null, offers: () => false, inbox: () => null },
    });
    expect(await login(fakePage({ text: [], present: () => true }).fp, "s")).toBe("no-credential");
    const withCred = loginProvider([site], {
      credentials: memoryCredentials({ s: { username: "u", password: "p" } }),
      codes: { get: async () => null, offers: () => false, inbox: () => null },
    });
    await expect(withCred(fakePage({ text: [], present: () => true }).fp, "s")).rejects.toThrow(
      /no totp code/,
    );
  });
});

describe("sign in via a provider on a site nobody wrote a spec for", () => {
  /** A site login page, then the provider's page, then the site signed in; `present` answers the button and the consent. */
  function viaPage(urls: string[]) {
    let at = 0;
    const acts: Hints[] = [];
    const fp: FlowPage = {
      captcha: async () => ({ solved: false, kind: null, vendor: null, reason: "fake" }),
      page: {} as FlowPage["page"],
      async open() {},
      url: () => urls[Math.min(at, urls.length - 1)] as string,
      text: async () => "",
      html: async () => "",
      has: async (h) => h.name === "/google/i" || h.name === "/^continue$/i",
      // Time passes: the page moves on one step per wait, as a real round trip would.
      wait: async () => {
        at++;
      },
      answer: async () => {},
      waitForUrl: async () => {
        at++;
        return true;
      },
      nextPage: async () => null,
      pages: () => [],
      switchTo() {},
      async act(_op, hints) {
        acts.push(hints);
      },
      human(reason) {
        throw new NeedsHuman(reason);
      },
    };
    return { fp, acts };
  }

  it("takes the provider path when the credential says via, presses its button, signs in there, lands", async () => {
    const { fp, acts } = viaPage([
      "https://new.test/login",
      "https://accounts.google.com/o/oauth2/auth",
      "https://new.test/app",
    ]);
    const login = loginProvider([], {
      credentials: memoryCredentials({
        "new.test": { username: "me@x.test", via: "google" },
        google: { username: "me@x.test", password: "p", totpSecret: RFC_SECRET },
      }),
      codes: totpSource(),
    });
    expect(await login(fp, "new.test")).toBe("signed-in");
    expect(acts[0]).toEqual({ role: "button", name: "/google/i" });
  });

  it("a via credential without a url on a page that is not a login is told what to store", async () => {
    const login = viaLogin("x", { username: "u", via: "google", recoveryCodes: [], passkeys: [] });
    expect(login.home).toBe("");
    expect(login.site).toBe("x");
  });

  it("a password-less credential is refused by a form login, in words", async () => {
    const { fp } = fakePage({ text: [], present: () => true });
    await expect(
      formLogin(
        "s",
        spec,
      )({
        fp,
        cred: { username: "u", via: "google", recoveryCodes: [], passkeys: [] },
        code: async () => "1",
        offers: () => false,
        inbox: () => null,
        credFor: async () => {
          throw new Error("x");
        },
        as: () => {
          throw new Error("x");
        },
      }),
    ).rejects.toThrow(/no password .*via google/);
  });
});

describe("loginProvider on the site's own sign-in page", () => {
  it("answers in place instead of opening home", async () => {
    const calls: string[] = [];
    const site: SiteLogin = {
      site: "s",
      home: "https://site.test/",
      loggedIn: async () => true,
      async signIn() {
        calls.push("signIn");
      },
      signInHere: {
        at: /accounts\.site\.test/,
        async run() {
          calls.push("here");
        },
      },
    };
    const login = loginProvider([site], {
      credentials: memoryCredentials({ s: { username: "u", password: "p" } }),
      codes: totpSource(),
    });
    const onWall = fakePage({
      text: [],
      present: () => true,
      url: "https://accounts.site.test/pwd",
    });
    onWall.fp.waitForUrl = async () => false; // the page never leaves the sign-in surface
    await expect(login(onWall.fp, "s")).rejects.toThrow(/still on/);
    expect(calls).toEqual(["here"]);
    const elsewhere = fakePage({ text: [], present: () => true, url: "https://site.test/x" });
    expect(await login(elsewhere.fp, "s")).toBe("signed-in");
    expect(calls).toEqual(["here", "signIn"]);
  });
});

describe("landAfterOauth", () => {
  const spec = {
    success: /console\.x\.test\//,
    challenge: {
      at: /login\.x\.test\/mfa/,
      async run(ctx: SignInContext) {
        await ctx.fp.act({ kind: "fill", value: await ctx.code("sms") }, { id: "code" });
      },
    },
  };
  const at = (urls: string[]) => {
    const { fp, acts } = fakePage({ text: [], present: () => true });
    let i = 0;
    fp.url = () => urls[Math.min(i, urls.length - 1)] ?? "";
    fp.waitForUrl = async (p) => {
      i = Math.min(i + 1, urls.length - 1);
      return p instanceof RegExp ? p.test(fp.url()) : p(fp.url());
    };
    const ctx = {
      fp,
      cred: { username: "u", password: "p" },
      code: async () => "424242",
      offers: () => true,
      inbox: () => null,
      credFor: async () => ({ username: "g", password: "p" }),
      as: () => ctx,
    } as SignInContext;
    return { ctx, acts };
  };
  it("answers the site's challenge with the site's code, then reaches home", async () => {
    const { ctx, acts } = at([
      "https://accounts.google.test/",
      "https://login.x.test/mfa?s=1",
      "https://console.x.test/account/",
    ]);
    await landAfterOauth("x", spec, ctx);
    expect(acts).toEqual([{ op: { kind: "fill", value: "424242" }, hints: { id: "code" } }]);
  });
  it("skips the challenge when the site goes straight home, and fails when it goes nowhere", async () => {
    const home = at(["https://accounts.google.test/", "https://console.x.test/account/"]);
    await landAfterOauth("x", spec, home.ctx);
    expect(home.acts).toEqual([]);
    const stuck = at(["https://accounts.google.test/", "https://login.x.test/error"]);
    await expect(landAfterOauth("x", spec, stuck.ctx)).rejects.toThrow(/still on .*error/);
  });
});

describe("signInToGoogle second step", () => {
  const base = { username: "u@gmail.com", password: "p", recoveryCodes: [], passkeys: [] };
  const page = (present: (h: Hints) => boolean) =>
    fakePage({
      text: ["2-Step Verification Choose how you want to sign in", "welcome"],
      present: (h) => !/switch account/i.test(String(h.name)) && present(h),
      url: "https://accounts.google.com/v3/signin/challenge/selection?x",
    });
  const ctx = (
    fp: FlowPage,
    kinds: CodeKind[],
    notify?: (t: string) => Promise<void>,
  ): SignInContext => ({
    fp,
    cred: base,
    code: async (kind) => (kinds.includes(kind) ? "123456" : Promise.reject(new Error("none"))),
    offers: (kind) => kinds.includes(kind),
    inbox: (kind) => (kind === "sms" && kinds.includes(kind) ? "+15555550182" : null),
    ...(notify ? { notify } : {}),
    credFor: async () => base,
    as: () => ctx(fp, kinds, notify),
  });
  it("continues past the OAuth consent page", async () => {
    const { fp, acts } = fakePage({
      text: ["Loading"],
      present: (h) => h.name === "/^continue$/i",
      url: "https://accounts.google.com/signin/oauth/id?authuser=0",
    });
    await signInToGoogle(ctx(fp, ["totp"]));
    expect(acts.map((a) => a.hints.name)).toEqual(["/^continue$/i"]);
  });
  it("switches account when the profile is signed in as someone else", async () => {
    const { fp, acts } = fakePage({
      text: [
        "Hi Other other@gmail.com Enter your password",
        "Choose an account other@gmail.com Use another account",
        "Sign in Email or phone",
        "welcome",
      ],
      present: (h) => !/password/i.test(String(h.name)) && h.text !== "u@gmail.com",
      url: "https://accounts.google.com/v3/signin/challenge/pwd?x",
    });
    await signInToGoogle(ctx(fp, ["totp"]));
    expect(acts.slice(0, 3).map((a) => `${a.op.kind} ${a.hints.name ?? a.hints.text}`)).toEqual([
      "click /switch account/i",
      "click /use another account/i",
      "fill /email or phone/i",
    ]);
  });
  const smsPage = (h: Hints) =>
    !/email|password|phone number/i.test(String(h.name)) &&
    !/too many|wrong code/i.test(String(h.text));
  it("asks for the SMS when a phone or Twilio can read it", async () => {
    const { fp, acts } = page(smsPage);
    await signInToGoogle(ctx(fp, ["sms"]));
    expect(acts.map((a) => `${a.op.kind} ${a.hints.name ?? a.hints.css}`)).toEqual([
      'click :is(a,button,[role=link],[role=button]):not([aria-disabled="true"]):has-text("verification code at"):has-text("••82")',
      "fill /code/i",
      "click /^next$/i",
    ]);
  });
  it("a page asking for a phone gets ours, then the code", async () => {
    const { fp, acts } = page((h) => smsPage(h) || h.name === "/^phone number$/i");
    await signInToGoogle(ctx(fp, ["sms"]));
    expect(acts.map((a) => `${a.op.kind} ${a.hints.name}`)).toEqual([
      "fill /^phone number$/i",
      "click /^next$/i",
      "fill /code/i",
      "click /^next$/i",
    ]);
  });
  it("too many failed attempts ends the sign-in with a plain reason, no guess", async () => {
    const { fp, acts } = page((h) => smsPage(h) || /too many/i.test(String(h.text)));
    await expect(signInToGoogle(ctx(fp, ["sms"]))).rejects.toThrow(/try again in a few hours/);
    expect(acts.some((a) => a.hints.name === "/code/i")).toBe(false);
  });
  it("pings the phone for a Tap Yes when only a phone is linked", async () => {
    const notes: string[] = [];
    const { fp, acts } = page((h) => !/email|password/i.test(String(h.name)));
    await signInToGoogle(
      ctx(fp, [], async (t) => {
        notes.push(t);
      }),
    );
    expect(acts.map((a) => `${a.op.kind} ${a.hints.css}`)).toEqual([
      'click :is(a,button,[role=link],[role=button]):not([aria-disabled="true"]):has-text("Tap Yes on your phone")',
    ]);
    expect(notes[0]).toMatch(/tap Yes/);
  });
  it("a passkey prompt after the password goes to the other steps, then the authenticator", async () => {
    let n = 0;
    const { fp, acts } = fakePage({
      text: [
        "Hi u@gmail.com Enter your password",
        "Use your passkey to confirm it's really you More ways to verify",
        "2-Step Verification Choose how you want to sign in",
        "welcome",
      ],
      present: (h) => !/email|switch account/i.test(String(h.name)),
      url: () =>
        n < 2
          ? "https://accounts.google.com/v3/signin/challenge/pwd?x"
          : n === 2
            ? "https://accounts.google.com/v3/signin/challenge/pk/presend?x"
            : "https://accounts.google.com/v3/signin/challenge/selection?x",
      onAct: (count) => {
        n = count;
      },
    });
    await signInToGoogle(ctx(fp, ["totp"]));
    expect(acts.map((a) => `${a.op.kind} ${a.hints.name ?? a.hints.text ?? a.hints.css}`)).toEqual([
      "fill /password/i",
      "click /^next$/i",
      "click /try another way|more ways to verify/i",
      'click :is(a,button,[role=link],[role=button]):not([aria-disabled="true"]):has-text("authenticator app")',
      "fill /code/i",
      "click /^next$/i",
    ]);
  });
  it("says what to set up when nothing can answer", async () => {
    const { fp } = page((h) => !/email|password/i.test(String(h.name)));
    await expect(signInToGoogle(ctx(fp, []))).rejects.toThrow(/enroll TOTP, link a phone/);
  });
  it("a passkey we hold answers first; when Google refuses it the error says so", async () => {
    const pk = {
      rpId: "google.com",
      credentialId: "c",
      privateKey: "k",
      signCount: 1,
      isResidentCredential: true,
    };
    const { fp, acts } = fakePage({
      text: [
        "u@gmail.com Verify it's you Choose a way to verify Use your passkey",
        "u@gmail.com Something went wrong",
      ],
      present: (h) => !/email|password|authenticator|switch account/i.test(String(h.css ?? h.name)),
      url: "https://accounts.google.com/v3/signin/challenge/selection?x",
    });
    // The ceremony never leaves the challenge: Google did not recognise the passkey.
    fp.waitForUrl = async (p) =>
      typeof p === "function"
        ? p("https://accounts.google.com/v3/signin/challenge/pk/error?x")
        : true;
    const c = ctx(fp, ["totp"]);
    await expect(signInToGoogle({ ...c, cred: { ...base, passkeys: [pk] } })).rejects.toThrow(
      /does not offer the authenticator app here; our passkey was refused/,
    );
    expect(acts[0]?.hints.css).toMatch(/Use your passkey/);
  });
});

describe("resolveLogin", () => {
  const sites = [
    { site: "google", home: "https://g", loggedIn: async () => true, signIn: async () => {} },
    {
      site: "cf",
      home: "https://c",
      credential: "google",
      loggedIn: async () => true,
      signIn: async () => {},
    },
  ] as const;
  it("a bare name is the spec itself", () => {
    expect(resolveLogin(sites, "google")).toBe(sites[0]);
    expect(credentialFor(sites, "cf")).toBe("google");
    expect(credentialFor(sites, "other")).toBe("other");
  });
  it("site@account is the same walk with its own credential and profile", () => {
    const l = resolveLogin(sites, "google@ops");
    expect(l).toMatchObject({ site: "google@ops", credential: "google@ops", home: "https://g" });
    expect(resolveLogin(sites, "nope@x")).toBeNull();
  });
  it("an app of a provider signs in as the provider, second accounts too", async () => {
    expect(resolveLogin(sites, "cf@ops")).toMatchObject({
      site: "cf@ops",
      credential: "google@ops",
    });
    const { SITE_LOGINS } = await import("../src/auth/sites.js");
    for (const app of ["gmail", "drive", "calendar", "docs", "sheets"])
      expect(credentialFor(SITE_LOGINS, app)).toBe("google");
    expect(credentialFor(SITE_LOGINS, "gmail@will")).toBe("google@will");
    expect(credentialFor(SITE_LOGINS, "outlook@work")).toBe("microsoft@work");
  });
});

describe("aws site login", () => {
  it("reads the identity from the username", async () => {
    const { awsIdentity, SITE_LOGINS } = await import("../src/auth/sites.js");
    expect(awsIdentity("ops@example.com")).toEqual({ kind: "root" });
    expect(awsIdentity("123456789012/william")).toEqual({
      kind: "iam",
      account: "123456789012",
      user: "william",
    });
    expect(() => awsIdentity("william")).toThrow(/account id or alias/);
    expect(SITE_LOGINS.map((s) => s.site)).toContain("aws");
  });
});
