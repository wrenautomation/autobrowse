import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Credential } from "../src/auth/credentials.js";
import { LoginFailed, type SignInContext } from "../src/auth/login.js";
import { cloudflareWalk, savedProfileIs } from "../src/auth/sites.js";
import { defineFlow, type FlowPage, flowRunner, type Op } from "../src/browser/flow.js";
import { type Hints, namePattern } from "../src/browser/locate.js";
import type { Repairer } from "../src/browser/repair.js";
import {
  fileScreens,
  landmark,
  memoryScreens,
  type Screen,
  type ScreenHelp,
  type ScreenReader,
  urlShape,
  type Walk,
  walk,
} from "../src/browser/screens.js";
import { NeedsHuman } from "../src/browser/session.js";

/** A site as states: each has a URL, controls ("button:Log in"), text, and where a click or fill leads. */
type State = { url?: string; has: string[]; text?: string; on?: Record<string, string> };

function fakeSite(states: Record<string, State>, start: string) {
  let state = start;
  const acts: string[] = [];
  const control = (h: Hints): string | null => {
    for (const c of (states[state] as State).has) {
      const [role, name] = [c.slice(0, c.indexOf(":")), c.slice(c.indexOf(":") + 1)];
      const test = (want: string | undefined) => {
        if (!want) return true;
        const p = namePattern(want);
        return typeof p === "string" ? p === name : p.test(name);
      };
      if (h.role && h.role !== role) continue;
      if (h.text && !test(h.text)) continue;
      if (!test(h.name ?? undefined)) continue;
      if (!h.role && !h.text && !h.name) continue;
      return c;
    }
    return null;
  };
  const fp: FlowPage = {
    page: {} as FlowPage["page"],
    passkeys: {} as FlowPage["passkeys"],
    captcha: async () => ({ solved: false, kind: null, vendor: null, reason: "fake" }),
    async open() {},
    url: () => (states[state] as State).url ?? "https://site.test/login",
    text: async () => (states[state] as State).text ?? "",
    html: async () => "",
    has: async (h) => control(h) !== null,
    read: async (h) => control(h)?.slice(control(h)?.indexOf(":") ?? 0) ?? "",
    wait: async () => {},
    answer: async () => {},
    waitForUrl: async () => true,
    nextPage: async () => null,
    pages: () => [],
    switchTo() {},
    async act(op: Op, hints: Hints) {
      const c = control(hints);
      if (!c) throw new Error(`nothing matches ${JSON.stringify(hints)} in ${state}`);
      acts.push(
        `${op.kind} ${c.slice(c.indexOf(":") + 1)}${op.kind === "fill" ? `=${op.value}` : ""}`,
      );
      const next = (states[state] as State).on?.[`${op.kind} ${c}`];
      if (next) state = next;
    },
    async signIn() {
      return "no-login";
    },
    human(reason) {
      throw new NeedsHuman(reason);
    },
  };
  const go = (s: string) => {
    state = s;
  };
  return { fp, acts, at: () => state, go };
}

const google: Credential = { username: "will@gmail.com", password: "gpw", passkeys: [] };
const ctxOf = (fp: FlowPage, cred: Credential): SignInContext => ({
  fp,
  cred,
  code: async () => "123456",
  offers: () => true,
  inbox: () => null,
  credFor: async () => google,
  as: (c) => ctxOf(fp, c),
});

describe("screens", () => {
  it("shapes URLs and blurs landmarks so a page matches across ids and names", () => {
    expect(urlShape("https://dash.cloudflare.com/4f3a9c0e4f3a9c0e4f3a9c0e4f3a9c0e/home?x=1")).toBe(
      "dash.cloudflare.com/*/home",
    );
    expect(urlShape("https://x.com/i/flow/login/")).toBe("x.com/i/flow/login");
    expect(landmark("Continue as will@gmail.com  using Google")).toBe(
      "continue as <address> using google",
    );
    expect(landmark("Order #4821 shipped")).toBe("order ## shipped");
  });

  it("reads a saved profile's label, cut short or whole", () => {
    expect(savedProfileIs("Continue as will@gmail.com using Google", "will@gmail.com")).toBe(true);
    expect(savedProfileIs("Continue as wi… using Google", "will@gmail.com")).toBe(true);
    expect(savedProfileIs("Continue as wi…@gmail.com using Google", "will@gmail.com")).toBe(true);
    expect(savedProfileIs("Continue as wi… using Google", "bob@gmail.com")).toBe(false);
    expect(savedProfileIs("Continue as will@gmail.com using Google", "will@gmail.co")).toBe(false);
    expect(savedProfileIs("Sign in", "will@gmail.com")).toBe(false);
  });

  it("keeps learned pages by site, matched by URL shape and landmarks; a walk's screen over a click", () => {
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-screens-"));
    const file = join(dir, "screens.json");
    const learned = fileScreens(file);
    const look = {
      url: "x.com/login",
      landmarks: ["heading welcome", "button next", "field email"],
    };
    learned.keep({
      site: "x@wren",
      url: "x.com/login",
      landmarks: ["button next", "field email"],
      click: { role: "button", name: "Next" },
      reason: "a card",
    });
    learned.keep({
      site: "x",
      url: "x.com/login",
      landmarks: ["heading welcome", "button next"],
      walk: "sign-in",
      screen: "welcome",
      reason: "renamed",
    });
    learned.keep({
      site: "x",
      url: "x.com/login",
      landmarks: ["heading gone", "button next"],
      walk: "sign-in",
      screen: "other",
      reason: "",
    });
    // Too bare to tell apart: not kept.
    learned.keep({
      site: "x",
      url: "x.com/",
      landmarks: ["button ok"],
      click: { text: "ok" },
      reason: "",
    });
    expect(learned.list().map((r) => r.site)).toEqual(["x", "x", "x"]);
    expect(fileScreens(file).find("x@wren", "sign-in", look)?.screen).toBe("welcome");
    expect(learned.find("x", "other-walk", look)?.click).toEqual({ role: "button", name: "Next" });
    expect(learned.find("x", null, look)?.click).toEqual({ role: "button", name: "Next" });
    expect(learned.find("x", null, { ...look, url: "x.com/home" })).toBeNull();
    expect(learned.find("y", null, look)).toBeNull();
    expect(learned.has("x@wren")).toBe(true);
    expect(learned.forget("x")).toBe(3);
    expect(learned.has("x")).toBe(false);
  });

  const helpOf = (
    learned = memoryScreens(),
    reader: ScreenReader | null = null,
    landmarks = ["heading hello", "button continue"],
  ): ScreenHelp => ({
    look: async () => ({ url: "site.test/login", landmarks }),
    snapshot: async () => "button text=Continue",
    learned,
    reader,
  });

  const twoStep = (): Walk<{ fp: FlowPage }> => ({
    site: "site",
    name: "in",
    goal: "the home page",
    fail: (why) => {
      throw new Error(why);
    },
    screens: [
      { name: "home", looks: "home", at: /\/home$/, goal: true },
      {
        name: "welcome",
        looks: "a welcome card with Continue",
        shows: [{ role: "button", name: "Continue" }],
        act: ({ fp }) =>
          fp.act({ kind: "click" }, { role: "button", name: "Continue" }, { goal: "go on" }),
      },
      {
        name: "form",
        looks: "the form",
        shows: [{ role: "textbox", name: "Name" }],
        act: async ({ fp }) => {
          await fp.act(
            { kind: "fill", value: "w" },
            { role: "textbox", name: "Name" },
            { goal: "name" },
          );
          await fp.act({ kind: "click" }, { role: "button", name: "Send" }, { goal: "send" });
        },
      },
    ],
  });

  it("walks whichever screens come, in any order, to the goal", async () => {
    const s = fakeSite(
      {
        form: { has: ["textbox:Name", "button:Send"], on: { "click button:Send": "welcome" } },
        welcome: { has: ["button:Continue"], on: { "click button:Continue": "home" } },
        home: { url: "https://site.test/home", has: [] },
      },
      "form",
    );
    expect(await walk({ fp: s.fp }, twoStep())).toBe("home");
    expect(s.acts).toEqual(["fill Name=w", "click Send", "click Continue"]);
    s.go("welcome");
    expect(await walk({ fp: s.fp }, twoStep())).toBe("home");
  });

  it("the same screen three times running is stuck", async () => {
    const s = fakeSite({ welcome: { has: ["button:Continue"] } }, "welcome");
    await expect(walk({ fp: s.fp }, twoStep())).rejects.toThrow(/stuck on "welcome"/);
    expect(s.acts.length).toBe(2);
  });

  it("an unknown page: learned first, then the model names a known screen, and the answer is kept", async () => {
    const s = fakeSite(
      {
        // A redesign: the Continue button is now "Go on"; no screen shows it.
        card: { has: ["button:Go on"], on: { "click button:Go on": "home" } },
        home: { url: "https://site.test/home", has: [] },
      },
      "card",
    );
    const bare = { fp: s.fp };
    await expect(walk(bare, { ...twoStep(), fail: undefined })).rejects.toThrow(NeedsHuman);
    const asked: string[] = [];
    const reader: ScreenReader = {
      id: "fake",
      async read(req) {
        asked.push(req.known.map((k) => k.name).join(","));
        return { click: { role: "button", name: "Go on" }, reason: "a card in the way" };
      },
    };
    const learned = memoryScreens();
    s.fp.screens = helpOf(learned, reader);
    expect(await walk(bare, twoStep())).toBe("home");
    expect(asked).toEqual(["home,welcome,form"]);
    expect(learned.list()[0]).toMatchObject({
      site: "site",
      url: "site.test/login",
      click: { role: "button", name: "Go on" },
    });
    // Next time: no model.
    s.go("card");
    expect(await walk(bare, twoStep())).toBe("home");
    expect(asked.length).toBe(1);
    expect(learned.list()[0]?.used).toBe(1);
  });

  it("the model may only pick from the list, and never a click that commits", async () => {
    const s = fakeSite({ card: { has: ["button:Confirm order", "button:Continue"] } }, "card");
    const bare = { fp: s.fp };
    const walkOf = (reader: ScreenReader) => {
      s.fp.screens = helpOf(memoryScreens(), reader);
      // A walk that knows no screen with Continue: everything here is unknown.
      return walk(bare, {
        ...twoStep(),
        screens: [twoStep().screens[0] as Screen<{ fp: FlowPage }>],
      });
    };
    await expect(
      walkOf({ id: "x", read: async () => ({ screen: "checkout", reason: "" }) }),
    ).rejects.toThrow(/does not know/);
    await expect(
      walkOf({
        id: "x",
        read: async () => ({ click: { role: "button", name: "Confirm order" }, reason: "" }),
      }),
    ).rejects.toThrow(/does not know/);
    expect(s.acts).toEqual([]);
  });

  it("a learned answer that stops working is dropped", async () => {
    const s = fakeSite({ card: { has: ["button:Later"] } }, "card");
    const learned = memoryScreens();
    learned.keep({
      site: "site",
      url: "site.test/login",
      landmarks: ["heading hello", "button continue"],
      click: { role: "button", name: "Go on" },
      reason: "",
    });
    s.fp.screens = helpOf(learned);
    await expect(walk({ fp: s.fp }, twoStep())).rejects.toThrow(/nothing matches/);
    expect(learned.list()).toEqual([]);
  });

  describe("cloudflare", () => {
    const cred: Credential = {
      username: "will@gmail.com",
      password: "cfpw",
      previousPassword: "old",
      passkeys: [],
    };
    const states = (): Record<string, State> => ({
      saved: {
        has: ["button:Continue as wi… using Google", "button:Sign in with another profile"],
        on: {
          "click button:Continue as wi… using Google": "google",
          "click button:Sign in with another profile": "form",
        },
      },
      google: {
        url: "https://accounts.google.com/o/oauth2/auth",
        has: ["text:will@gmail.com"],
        on: { "click text:will@gmail.com": "dashboard" },
      },
      form: {
        has: ["textbox:Email", "textbox:Password", "button:Log in", "button:Sign in with Google"],
        on: { "click button:Log in": "dashboard", "click button:Sign in with Google": "dashboard" },
      },
      rejected: {
        has: ["textbox:Email", "textbox:Password", "button:Log in"],
        text: "Incorrect email or password",
        on: { "click button:Log in": "dashboard" },
      },
      code: {
        has: ["textbox:Code", "button:Continue"],
        text: "Enter the code from your authenticator app",
        on: { "click button:Continue": "dashboard" },
      },
      dashboard: {
        url: "https://dash.cloudflare.com/4f3a9c0e4f3a9c0e4f3a9c0e4f3a9c0e/home",
        has: [],
      },
    });

    it("rides the saved profile when it is this account: nothing typed", async () => {
      const s = fakeSite(states(), "saved");
      const ctx = ctxOf(s.fp, cred);
      expect(await walk(ctx, cloudflareWalk(ctx))).toBe("dashboard");
      expect(s.acts).toEqual(["click Continue as wi… using Google", "click will@gmail.com"]);
    });

    it("someone else's saved profile: another profile, then the password", async () => {
      const s = fakeSite(states(), "saved");
      const ctx = ctxOf(s.fp, { ...cred, username: "ops@wren.dev" });
      expect(await walk(ctx, cloudflareWalk(ctx))).toBe("dashboard");
      expect(s.acts).toEqual([
        "click Sign in with another profile",
        "fill Email=ops@wren.dev",
        "fill Password=cfpw",
        "click Log in",
      ]);
    });

    it("a via-google account presses the Google button on the form", async () => {
      const s = fakeSite(states(), "form");
      const ctx = ctxOf(s.fp, { username: "will@gmail.com", via: "google", passkeys: [] });
      expect(await walk(ctx, cloudflareWalk(ctx))).toBe("dashboard");
      expect(s.acts).toEqual(["click Sign in with Google"]);
    });

    it("a rejected password gets the previous one once, then fails as LoginFailed", async () => {
      const s = fakeSite(states(), "rejected");
      const ctx = ctxOf(s.fp, cred);
      expect(await walk(ctx, cloudflareWalk(ctx))).toBe("dashboard");
      expect(s.acts).toEqual(["fill Password=old", "click Log in"]);
      const stuck = fakeSite(
        { ...states(), rejected: { ...(states().rejected as State), on: {} } },
        "rejected",
      );
      const c2 = ctxOf(stuck.fp, cred);
      await expect(walk(c2, cloudflareWalk(c2))).rejects.toThrow(LoginFailed);
      await expect(
        walk(c2, cloudflareWalk(ctxOf(stuck.fp, { ...cred, previousPassword: undefined }))),
      ).rejects.toThrow(/password rejected/);
    });

    it("a code page gets the authenticator code", async () => {
      const s = fakeSite(states(), "code");
      const ctx = ctxOf(s.fp, cred);
      expect(await walk(ctx, cloudflareWalk(ctx))).toBe("dashboard");
      expect(s.acts).toEqual(["fill Code=123456", "click Continue"]);
    });

    it("the riding path stops when Google wants a password", async () => {
      const st = states();
      (st.google as State).has = ["textbox:Password"];
      const s = fakeSite(st, "saved");
      const ctx = ctxOf(s.fp, cred);
      await expect(walk(ctx, cloudflareWalk(ctx))).rejects.toThrow(/saved Google session is gone/);
    });
  });

  describe("interrupts in the runner", () => {
    const server = createServer((q, r) =>
      r.writeHead(200, { "content-type": "text/html" }).end(
        q.url === "/banner"
          ? // A cookie dialog over the whole page; the button under it.
            `<title>t</title><h1>Shop</h1><button onclick="document.title='paid'">Pay now</button>
             <div role="dialog" class="cookie-notice" style="position:fixed;inset:0;background:#fff8">We use cookies. <button onclick="this.parentElement.remove()">Reject all</button><button>Accept all</button></div>`
          : // A screen in the way: "Pay now" shows only after "Continue".
            `<title>t</title><h1>Checkout</h1><button onclick="this.remove();document.getElementById('p').hidden=false">Continue</button><button id=p hidden onclick="document.title='paid'">Pay now</button>`,
      ),
    );
    const ready = new Promise<string>((ok) =>
      server.listen(0, "127.0.0.1", () =>
        ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`),
      ),
    );
    afterAll(() => server.close());
    const runnerIn = (dir: string, extra: Parameters<typeof flowRunner>[1]) =>
      flowRunner(
        {
          tier: "local",
          channel: "chromium",
          profilesDir: join(dir, "profiles"),
          artifactsDir: join(dir, "artifacts"),
          headless: true,
        },
        { pace: null, ...extra },
      );
    const pay = (url: string) =>
      defineFlow<undefined, string>({
        site: "scratch",
        name: "pay",
        async run(fp) {
          await fp.open(url);
          await fp.act(
            { kind: "click" },
            { role: "button", name: "Pay now" },
            { goal: "pay", timeoutMs: 3_000 },
          );
          return fp.page.title();
        },
      });
    const never: Repairer = {
      id: "never",
      propose: async () => {
        throw new Error("the model was asked");
      },
    };

    it("a cookie banner is declined before the step, with no model", async () => {
      const dir = mkdtempSync(join(tmpdir(), "autobrowse-banner-"));
      const runner = runnerIn(dir, { repairer: never });
      expect(await runner.run(pay(`${await ready}banner`), undefined)).toBe("paid");
    }, 60_000);

    it("a click learned on the site gets every flow past that screen, with no model", async () => {
      const dir = mkdtempSync(join(tmpdir(), "autobrowse-learned-"));
      const learned = memoryScreens();
      const url = `${await ready}screen`;
      learned.keep({
        site: "scratch",
        url: urlShape(url),
        landmarks: ["heading checkout", "button continue"],
        click: { role: "button", name: "Continue" },
        reason: "a screen before the form",
      });
      const runner = runnerIn(dir, { repairer: never, learnedScreens: learned });
      expect(await runner.run(pay(url), undefined)).toBe("paid");
      expect(learned.list()[0]?.used).toBe(1);
    }, 60_000);

    it("a repair's detour is kept for the whole site", async () => {
      const dir = mkdtempSync(join(tmpdir(), "autobrowse-detour-"));
      const learned = memoryScreens();
      const repairer: Repairer = {
        id: "detour",
        propose: async (req) =>
          req.detours?.length
            ? { hints: { role: "button", name: "Pay now" }, reason: "behind a screen" }
            : {
                hints: { role: "button", name: "Continue" },
                reason: "a screen first",
                detour: true,
              },
      };
      const url = `${await ready}screen`;
      expect(
        await runnerIn(dir, { repairer, learnedScreens: learned }).run(pay(url), undefined),
      ).toBe("paid");
      expect(learned.list()[0]).toMatchObject({
        site: "scratch",
        url: urlShape(url),
        landmarks: ["heading checkout", "button continue"],
        click: { role: "button", name: "Continue" },
      });
      // Another flow on the site, another run: the model is never asked.
      const other = defineFlow<undefined, string>({ ...pay(url), name: "pay-again" });
      expect(
        await runnerIn(dir, { repairer: never, learnedScreens: learned }).run(other, undefined),
      ).toBe("paid");
    }, 90_000);
  });
});
