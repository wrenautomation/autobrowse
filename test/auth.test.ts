import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  credentialEnv,
  envCredentials,
  fileCredentials,
  layeredCredentials,
} from "../src/auth/credentials.js";
import {
  base32Decode,
  type CodeKind,
  codeSources,
  credentialFor,
  extractCode,
  findTotpSecret,
  formLogin,
  LoginFailed,
  landAfterOauth,
  loginProvider,
  type Message,
  memoryCredentials,
  messageSource,
  parseOtpauth,
  resolveLogin,
  type SignInContext,
  type SiteLogin,
  signInToGoogle,
  totp,
  totpRemainingMs,
  totpSource,
  viaLogin,
} from "../src/auth/index.js";
import type { FlowPage, Op } from "../src/browser/flow.js";
import type { Hints } from "../src/browser/locate.js";
import { NeedsHuman } from "../src/browser/session.js";
import { fakePage } from "./auth-fakes.js";

// RFC 6238 test vector: secret "12345678901234567890" (base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ).
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp", () => {
  it("decodes base32", () => {
    expect(base32Decode("GEZDGNBVGY3TQOJQ").toString()).toBe("1234567890");
    expect(base32Decode("gezd gnbv-gy3t qojq").toString()).toBe("1234567890");
  });
  it("matches the RFC 6238 vectors", () => {
    expect(totp(RFC_SECRET, { at: 59_000, digits: 8 })).toBe("94287082");
    expect(totp(RFC_SECRET, { at: 1_111_111_109_000, digits: 8 })).toBe("07081804");
    expect(totp(RFC_SECRET, { at: 59_000 })).toBe("287082");
  });
  it("knows when the code rolls over", () => {
    expect(totpRemainingMs(59_000)).toBe(1_000);
    expect(totpRemainingMs(60_000)).toBe(30_000);
  });
  it("parses otpauth URIs", () => {
    const p = parseOtpauth(
      "otpauth://totp/Cloudflare:will%40example.com?secret=jbsw%20y3dp-ehpk3pxp&issuer=Cloudflare&digits=6",
    );
    expect(p).toEqual({
      secret: "JBSWY3DPEHPK3PXP",
      issuer: "Cloudflare",
      account: "will@example.com",
      digits: 6,
      period: 30,
      algorithm: "sha1",
    });
  });
  it("finds the seed on a page: URI first, then a manual key, else nothing", () => {
    expect(
      findTotpSecret(
        '<img src="data:..."><a href="otpauth://totp/X:a?secret=JBSWY3DPEHPK3PXP&amp;issuer=X">',
      ),
    ).toBe("JBSWY3DPEHPK3PXP");
    expect(findTotpSecret("Can't scan? Enter this key: jbsw y3dp ehpk 3pxp")).toBe(
      "JBSWY3DPEHPK3PXP",
    );
    expect(findTotpSecret("Welcome back, nothing to see")).toBeNull();
  });
  it("keeps the key apart from the 4-letter words after it", () => {
    const google =
      "Enter your email address and this key (spaces don’t matter): jbsw y3dp ehpk 3pxp jbsw y3dp ehpk 3pxp Make sure Time based is selected Tap Add to finish";
    expect(findTotpSecret(google)).toBe("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    expect(findTotpSecret("key: jbsw y3dp ehpk 3pxp then tap add")).toBe("JBSWY3DPEHPK3PXP");
    expect(findTotpSecret("MAKE SURE TIME BASED IS SELECTED")).toBeNull();
  });
});

describe("credentials", () => {
  it("file store writes 0600, round-trips, and lists names only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-creds-"));
    const store = fileCredentials(join(dir, "c.json"));
    await store.put("cloudflare", { username: "u", password: "p", totpSecret: RFC_SECRET });
    expect(statSync(join(dir, "c.json")).mode & 0o777).toBe(0o600);
    expect(await store.list()).toEqual(["cloudflare"]);
    expect((await store.get("cloudflare"))?.totpSecret).toBe(RFC_SECRET);
    expect(await store.get("nope")).toBeNull();
  });
  it("env store reads AUTOBROWSE_CRED_* and is read-only", async () => {
    const env = {
      AUTOBROWSE_CRED_GOOGLE_ADMIN_USERNAME: "a@b.co",
      AUTOBROWSE_CRED_GOOGLE_ADMIN_PASSWORD: "pw",
    };
    const store = envCredentials(env);
    expect(await store.list()).toEqual(["google-admin"]);
    expect((await store.get("google-admin"))?.username).toBe("a@b.co");
    await expect(store.put("x", { username: "u", password: "p" })).rejects.toThrow(/read-only/);
  });
  it("a credential round-trips through env entries, via-only included", async () => {
    const entries = credentialEnv("my-site", {
      username: "w@wren.co",
      via: "google",
      codesInbox: "codes@wren.co",
      recoveryCodes: [],
      passkeys: [],
    });
    expect(entries.map((e) => e.name)).toEqual([
      "AUTOBROWSE_CRED_MY_SITE_USERNAME",
      "AUTOBROWSE_CRED_MY_SITE_VIA",
      "AUTOBROWSE_CRED_MY_SITE_CODES_INBOX",
    ]);
    const env = Object.fromEntries(entries.map((e) => [e.name, e.value]));
    const back = await envCredentials(env).get("my-site");
    expect(back?.via).toBe("google");
    expect(back?.codesInbox).toBe("codes@wren.co");
    expect(back?.password).toBeUndefined();
  });
  it("layered: first hit wins, writes go to the first store", async () => {
    const a = memoryCredentials({ s: { username: "a", password: "1" } });
    const b = memoryCredentials({
      s: { username: "b", password: "2" },
      t: { username: "t", password: "3" },
    });
    const l = layeredCredentials([a, b], a);
    expect((await l.get("s"))?.username).toBe("a");
    expect((await l.get("t"))?.username).toBe("t");
    await l.put("n", { username: "n", password: "4" });
    expect(await a.list()).toContain("n");
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
      waitForUrl: async () => {
        at++;
        return true;
      },
      nextPage: async () => null,
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
  it("asks for the SMS when a phone or Twilio can read it", async () => {
    const { fp, acts } = page((h) => !/email|password/i.test(String(h.name)));
    await signInToGoogle(ctx(fp, ["sms"]));
    expect(acts.map((a) => `${a.op.kind} ${a.hints.name ?? a.hints.css}`)).toEqual([
      'click :is(a,button,[role=link],[role=button]):not([aria-disabled="true"]):has-text("verification code at"):has-text("••82")',
      "fill /code/i",
      "click /^next$/i",
    ]);
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
});

describe("credential schema", () => {
  it("takes a via credential without a password, and nothing without either", async () => {
    const store = memoryCredentials();
    await store.put("s", { username: "u", via: "google", url: "https://s.test/login" });
    expect((await store.get("s"))?.password).toBeUndefined();
    await expect(store.put("t", { username: "u" })).rejects.toThrow(/password or a via/);
  });
  it("normalizes a spaced seed and rejects a 6-digit code", async () => {
    const store = memoryCredentials();
    await store.put("s", { username: "u", password: "p", totpSecret: "jbsw y3dp-ehpk 3pxp" });
    expect((await store.get("s"))?.totpSecret).toBe("JBSWY3DPEHPK3PXP");
    await expect(
      store.put("s", { username: "u", password: "p", totpSecret: "123456" }),
    ).rejects.toThrow(/base32 seed/);
  });
});

describe("sealed credential file", () => {
  it("writes ciphertext, reads it back, and upgrades a plain file on the next write", async () => {
    const { aesGcmCipher, isSealed } = await import("../src/auth/cipher.js");
    const { readFileSync, writeFileSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-sealed-"));
    const file = join(dir, "c.json");
    const key = Buffer.alloc(32, 7);
    writeFileSync(
      file,
      JSON.stringify({ sites: { old: { username: "o", password: "p", recoveryCodes: [] } } }),
    );
    const store = fileCredentials(file, aesGcmCipher(key));
    expect((await store.get("old"))?.username).toBe("o");
    await store.put("new", { username: "n", password: "q" });
    const raw = readFileSync(file, "utf8");
    expect(isSealed(raw)).toBe(true);
    expect(raw).not.toContain("password");
    expect((await store.get("old"))?.username).toBe("o");
    expect((await store.get("new"))?.password).toBe("q");
    await expect(
      fileCredentials(file, aesGcmCipher(Buffer.alloc(32, 8))).get("new"),
    ).rejects.toThrow();
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
