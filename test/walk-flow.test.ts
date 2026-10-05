import type { Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import type { CaptchaOutcome } from "../src/browser/captcha/index.js";
import type { FlowPage } from "../src/browser/flow.js";
import type { Hints } from "../src/browser/locate.js";
import { NeedsHuman } from "../src/browser/session.js";
import type { Passkeys } from "../src/browser/webauthn.js";
import type { SecretSink } from "../src/deps/sink.js";
import { walkFlow } from "../src/walks/flow.js";
import type { WalkOp, WalkSpec } from "../src/walks/spec.js";

/** A page of the fake site: its address, what lookAt sees, and where an act goes. */
interface FakePage {
  url: string;
  landmarks: string[];
  go?: Record<string, string>;
}

/** A site as a state machine; acts are logged as `<kind> <name>[ = value]`. Waits are instant. */
function fakeSite(
  pages: Record<string, FakePage>,
  first: string,
  o: { captcha?: CaptchaOutcome; reads?: Record<string, string> } = {},
) {
  const at = (key: string): FakePage => {
    const p = pages[key];
    if (!p) throw new Error(`fake site has no page ${key}`);
    return p;
  };
  let cur = at(first);
  const log: string[] = [];
  const unused = (what: string) => () => {
    throw new Error(`walk used fp.${what}`);
  };
  const page = {
    url: () => cur.url,
    evaluate: async () => cur.landmarks,
    isClosed: () => false,
  } as unknown as Page;
  const fp: FlowPage = {
    page,
    passkeys: {} as Passkeys,
    async open(url) {
      log.push(`open ${url}`);
      cur = Object.values(pages).find((p) => p.url === url) ?? { url, landmarks: [] };
    },
    url: () => cur.url,
    text: async () => cur.landmarks.join("\n"),
    html: async () => "",
    has: async () => false,
    async read(h: Hints) {
      log.push(`read ${h.name}`);
      return o.reads?.[h.name ?? ""] ?? `text of ${h.name}`;
    },
    wait: async () => {},
    answer: unused("answer"),
    waitForUrl: unused("waitForUrl"),
    nextPage: unused("nextPage"),
    scroll: unused("scroll"),
    pages: unused("pages"),
    switchTo: unused("switchTo"),
    async act(op, h, opts) {
      const v =
        op.kind === "fill" || op.kind === "select"
          ? ` = ${op.value}`
          : op.kind === "press"
            ? ` ${op.key}`
            : op.kind === "upload"
              ? ` ${op.files.join(",")}`
              : "";
      log.push(`${op.kind} ${h.name}${v}${opts.irreversible ? " (irreversible)" : ""}`);
      const next = cur.go?.[`${op.kind} ${h.name}`];
      if (next) cur = at(next);
    },
    signIn: unused("signIn") as FlowPage["signIn"],
    async captcha() {
      log.push("captcha");
      return o.captcha ?? { solved: true, kind: "checkbox", vendor: "recaptcha", rounds: 1 };
    },
    human(reason: string): never {
      throw new NeedsHuman(reason);
    },
  };
  return { fp, log, now: () => cur };
}

const hints = (role: string, name: string) => ({ role, name });
const click = (name: string, irreversible = false): WalkOp => ({
  kind: "click",
  goal: `click ${name}`,
  hints: hints("button", name),
  irreversible,
});
const fill = (name: string, value: Extract<WalkOp, { kind: "fill" }>["value"]): WalkOp => ({
  kind: "fill",
  goal: `fill ${name}`,
  hints: hints("textbox", name),
  value,
});

const SITE = {
  signup: {
    url: "https://site.test/signup?ref=ad",
    landmarks: ["Heading Join the list", "field Email", "field Password", "button Continue"],
    go: { "click Continue": "details" },
  },
  details: {
    url: "https://site.test/details",
    landmarks: ["heading Your details", "field Company", "button Next"],
    go: { "click Next": "welcome" },
  },
  welcome: { url: "https://site.test/welcome", landmarks: ["heading You're in, a@site.test"] },
  other: { url: "https://site.test/other", landmarks: ["heading Somewhere else"] },
} satisfies Record<string, FakePage>;

const spec = (o: Partial<WalkSpec> = {}): WalkSpec => ({
  version: 1,
  site: "scratch",
  name: "join-list",
  goal: "join the list",
  built: "2026-09-30T12:00:00.000Z",
  from: [],
  start: "https://site.test/signup?ref=ad",
  fields: [{ key: "email", label: "Email", example: "example@site.test" }],
  secrets: [{ key: "scratch.password", label: "Password" }],
  irreversible: false,
  screens: [
    {
      name: "join-list-done",
      looks: "welcome",
      url: "site.test/welcome",
      // lookAt lowercases and blurs addresses.
      landmarks: ["heading you're in, <address>"],
      ops: [],
      goal: true,
      seen: 1,
    },
    {
      name: "sign-up",
      looks: "sign up",
      url: "site.test/signup",
      landmarks: ["heading join the list", "field email"],
      ops: [
        fill("Email", { from: "plan", field: "email" }),
        fill("Password", { from: "secret", key: "scratch.password" }),
        click("Continue"),
      ],
      seen: 1,
    },
    {
      name: "your-details",
      looks: "details",
      url: "site.test/details",
      landmarks: ["heading your details"],
      ops: [
        fill("Company", { from: "literal", text: "Acme" }),
        {
          kind: "read",
          goal: "read order",
          hints: hints("text", "Order number"),
          as: "orderNumber",
        },
        click("Next", true),
      ],
      seen: 1,
    },
  ],
  ...o,
});

const secrets = async (k: string) => (k === "scratch.password" ? "fake-pw-1" : null);

describe("walkFlow", () => {
  it("is a flow named walk-<name> on the walk's site", () => {
    const f = walkFlow(spec());
    expect(f.name).toBe("walk-join-list");
    expect(f.site).toBe("scratch");
  });

  it("opens the start and does each screen's ops until the goal", async () => {
    const { fp, log } = fakeSite(SITE, "other", { reads: { "Order number": "A-17" } });
    const out = await walkFlow(spec(), { secrets }).run(fp, { email: "a@site.test" });
    expect(log).toEqual([
      "open https://site.test/signup?ref=ad",
      "fill Email = a@site.test",
      "fill Password = fake-pw-1",
      "click Continue",
      "fill Company = Acme",
      "read Order number",
      "click Next (irreversible)",
    ]);
    expect(out).toEqual({
      goal: "join-list-done",
      read: { orderNumber: "A-17" },
      kept: [],
      screens: ["sign-up", "your-details"],
    });
  });

  it("stops at once when the page is already the goal", async () => {
    const { fp, log } = fakeSite(SITE, "welcome");
    const out = await walkFlow(spec({ start: null })).run(fp, {});
    expect(log).toEqual([]);
    expect(out).toEqual({ goal: "join-list-done", read: {}, kept: [], screens: [] });
  });

  it("fills a plan field from the run's example when the input leaves it out", async () => {
    const { fp, log } = fakeSite(SITE, "signup");
    await walkFlow(spec(), { secrets }).run(fp, {});
    expect(log).toContain("fill Email = example@site.test");
  });

  it("hands a plan field with no input and no example to a person", async () => {
    const { fp } = fakeSite(SITE, "signup");
    const w = spec({ fields: [{ key: "email", label: "Email", example: null }] });
    await expect(walkFlow(w, { secrets }).run(fp, {})).rejects.toThrow(
      new NeedsHuman("fill Email: no email given (--plan email=…)"),
    );
  });

  it("hands a secret it cannot get to a person", async () => {
    for (const deps of [{}, { secrets: async () => null }]) {
      const { fp, log } = fakeSite(SITE, "signup");
      const err = await walkFlow(spec(), deps)
        .run(fp, {})
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NeedsHuman);
      expect((err as Error).message).toBe(
        "fill Password: secret scratch.password is not available here",
      );
      expect(log.some((l) => l.startsWith("fill Password"))).toBe(false);
    }
  });

  it("hands a page no screen knows to a person", async () => {
    const pages = { ...SITE, signup: { ...SITE.signup, go: { "click Continue": "other" } } };
    const { fp } = fakeSite(pages, "signup");
    await expect(walkFlow(spec(), { secrets }).run(fp, {})).rejects.toThrow(
      "a page walk-join-list does not know: https://site.test/other",
    );
  });

  it("does a screen once: ops that leave the page as it was go to a person", async () => {
    const pages = { ...SITE, signup: { ...SITE.signup, go: {} } };
    const { fp, log } = fakeSite(pages, "signup");
    await expect(walkFlow(spec(), { secrets }).run(fp, {})).rejects.toBeInstanceOf(NeedsHuman);
    expect(log.filter((l) => l === "click Continue")).toHaveLength(1);
  });

  it("waits for the screens a screen comes after", async () => {
    // Back on the sign-up page after the details: the second visit is its own screen.
    const pages: Record<string, FakePage> = {
      ...SITE,
      details: { ...SITE.details, go: { "click Next": "again" } },
      again: { ...SITE.signup, go: { "click Done": "welcome" } },
    };
    const w = spec();
    w.screens.push({
      name: "sign-up-2",
      looks: "sign up again",
      url: "site.test/signup",
      // More landmarks: checked before sign-up, so only `after` keeps it off the first visit.
      landmarks: ["heading join the list", "field email", "field password", "button continue"],
      ops: [click("Done")],
      after: ["your-details"],
      seen: 1,
    });
    const { fp, log } = fakeSite(pages, "signup");
    const out = await walkFlow(w, { secrets }).run(fp, {});
    expect(out.screens).toEqual(["sign-up", "your-details", "sign-up-2"]);
    expect(log.filter((l) => l.startsWith("click"))).toEqual([
      "click Continue",
      "click Next (irreversible)",
      "click Done",
    ]);
  });

  it("puts a kept value in the sink by env name, never in the output", async () => {
    const put = vi.fn(async () => {});
    const sink: SecretSink = { put };
    const w = spec();
    w.screens[2]?.ops.splice(1, 1, {
      kind: "keep",
      goal: "keep the key",
      hints: hints("text", "API key"),
      env: "SCRATCH_API_KEY",
    });
    const { fp } = fakeSite(SITE, "signup", { reads: { "API key": "fake-key-123" } });
    const out = await walkFlow(w, { secrets, sink }).run(fp, {});
    expect(put).toHaveBeenCalledWith("SCRATCH_API_KEY", "fake-key-123");
    expect(out.kept).toEqual(["SCRATCH_API_KEY"]);
    expect(JSON.stringify(out)).not.toContain("fake-key-123");

    const again = fakeSite(SITE, "signup");
    await expect(walkFlow(w, { secrets }).run(again.fp, {})).rejects.toThrow(
      "keep the key: nowhere to keep SCRATCH_API_KEY here",
    );
  });

  it("does select, press, upload and open ops", async () => {
    const w = spec({ fields: [{ key: "resumeFile", label: "file", example: "/tmp/fake.pdf" }] });
    (w.screens[1] as WalkSpec["screens"][number]).ops = [
      { kind: "select", goal: "choose Pro", hints: hints("combobox", "Plan"), value: "Pro" },
      { kind: "press", goal: "press Enter", hints: hints("textbox", "Email"), key: "Enter" },
      {
        kind: "upload",
        goal: "upload",
        hints: hints("button", "Resume"),
        file: { from: "plan", field: "resumeFile" },
      },
      { kind: "open", goal: "open details", url: "https://site.test/details" },
    ];
    const { fp, log } = fakeSite(SITE, "signup");
    const out = await walkFlow(w).run(fp, { resumeFile: "/tmp/given.pdf" });
    expect(log.slice(1, 5)).toEqual([
      "select Plan = Pro",
      "press Email Enter",
      "upload Resume /tmp/given.pdf",
      "open https://site.test/details",
    ]);
    expect(out.screens).toEqual(["sign-up", "your-details"]);
  });

  it("solves a captcha with the runner, or hands an unsolved one to a person", async () => {
    const w = spec();
    w.screens[1]?.ops.unshift({ kind: "captcha", goal: "solve the captcha" });
    const ok = fakeSite(SITE, "signup");
    await walkFlow(w, { secrets }).run(ok.fp, {});
    expect(ok.log[1]).toBe("captcha");

    const no = fakeSite(SITE, "signup", {
      captcha: { solved: false, kind: null, vendor: null, reason: "no captcha on the page" },
    });
    await expect(walkFlow(w, { secrets }).run(no.fp, {})).rejects.toThrow(
      new NeedsHuman("solve the captcha: no captcha on the page"),
    );
    expect(no.log.some((l) => l.startsWith("fill"))).toBe(false);
  });

  it("hands a human op's reason to a person", async () => {
    const w = spec();
    w.screens[1]?.ops.unshift({ kind: "human", reason: "type the code from the SMS" });
    const { fp } = fakeSite(SITE, "signup");
    await expect(walkFlow(w, { secrets }).run(fp, {})).rejects.toThrow(
      new NeedsHuman("type the code from the SMS"),
    );
  });

  describe("walk ops", () => {
    const LOGIN: Record<string, FakePage> = {
      ...SITE,
      login: {
        url: "https://site.test/login",
        landmarks: ["heading Sign in", "field Password", "button Sign in"],
        go: { "click Sign in": "signup" },
      },
    };
    /** A sign-in walk: its start is never opened inside another walk. */
    const signIn: WalkSpec = {
      ...spec(),
      name: "sign-in",
      start: "https://site.test/elsewhere",
      fields: [],
      screens: [
        {
          name: "signed-in",
          looks: "the sign-up page",
          url: "site.test/signup",
          landmarks: ["heading join the list"],
          ops: [],
          goal: true,
          seen: 1,
        },
        {
          name: "password",
          looks: "sign in",
          url: "site.test/login",
          landmarks: ["heading sign in"],
          ops: [fill("Password", { from: "secret", key: "scratch.password" }), click("Sign in")],
          seen: 1,
        },
      ],
    };
    const outer = (walk: string): WalkSpec => {
      const w = spec({ start: "https://site.test/login" });
      w.screens.push({
        name: "login",
        looks: "sign in first",
        url: "site.test/login",
        landmarks: ["heading sign in"],
        ops: [{ kind: "walk", goal: "sign in", walk }],
        seen: 1,
      });
      return w;
    };

    it("runs another walk where the page is, by name on this site or site/name", async () => {
      for (const [ref, site] of [
        ["sign-in", "scratch"],
        ["google/sign-in", "google"],
      ] as const) {
        const load = vi.fn((_s: string, n: string) => (n === "sign-in" ? signIn : null));
        const { fp, log } = fakeSite(LOGIN, "other");
        const out = await walkFlow(outer(ref), { secrets, load }).run(fp, {});
        expect(load).toHaveBeenCalledWith(site, "sign-in");
        expect(log).not.toContain("open https://site.test/elsewhere");
        expect(log.slice(0, 3)).toEqual([
          "open https://site.test/login",
          "fill Password = fake-pw-1",
          "click Sign in",
        ]);
        expect(out.screens).toEqual(["sign-in/password", "login", "sign-up", "your-details"]);
        expect(out.goal).toBe("join-list-done");
      }
    });

    it("hands a walk it cannot load to a person", async () => {
      const { fp } = fakeSite(LOGIN, "other");
      await expect(
        walkFlow(outer("google/nope"), { secrets, load: () => null }).run(fp, {}),
      ).rejects.toThrow(new NeedsHuman("sign in: no walk google/nope"));
      const bare = fakeSite(LOGIN, "other");
      await expect(walkFlow(outer("nope"), { secrets }).run(bare.fp, {})).rejects.toThrow(
        "sign in: no walk scratch/nope",
      );
    });

    it("stops walks nesting deeper than four", async () => {
      const self = outer("join-list");
      const load = vi.fn(() => self);
      const { fp } = fakeSite(LOGIN, "other");
      await expect(walkFlow(self, { secrets, load }).run(fp, {})).rejects.toThrow(
        new NeedsHuman("sign in: walks nest deeper than 4"),
      );
      expect(load).toHaveBeenCalledTimes(4);
    });
  });

  it("passes a once:false screen as many times as the page comes back", async () => {
    const page = (n: number, next: string): FakePage => ({
      url: `https://site.test/results/${n}`,
      landmarks: ["heading results", "button next"],
      go: { "click Next": next },
    });
    const pages: Record<string, FakePage> = {
      r1: page(1, "r2"),
      r2: page(2, "r3"),
      r3: page(3, "end"),
      end: { url: "https://site.test/results/end", landmarks: ["heading the end"] },
    };
    const w = spec({
      start: "https://site.test/results/1",
      fields: [],
      secrets: [],
      screens: [
        {
          name: "the-end",
          looks: "end",
          url: "site.test/results/end",
          landmarks: ["heading the end"],
          ops: [],
          goal: true,
          seen: 1,
        },
        {
          name: "results",
          looks: "a page of results",
          url: "site.test/results/*",
          landmarks: ["heading results"],
          ops: [click("Next")],
          once: false,
          seen: 1,
        },
      ],
    });
    const { fp } = fakeSite(pages, "r1");
    const out = await walkFlow(w).run(fp, {});
    expect(out.screens).toEqual(["results", "results", "results"]);
  });
});

describe("walkFlow v2 values", () => {
  const v2 = (): WalkSpec =>
    spec({
      version: 2,
      fields: [
        { key: "company", label: "Company", example: null, default: "Acme" },
        { key: "start", label: "Start", example: null, default: "today+3d MM/DD/YYYY" },
        { key: "size", label: "Size", example: "11-50" },
      ],
      screens: [
        spec().screens[0] as WalkSpec["screens"][number],
        {
          name: "sign-up",
          looks: "sign up",
          url: "site.test/signup",
          landmarks: ["heading join the list", "field email"],
          ops: [
            fill("Email", { from: "profile", field: "email" }),
            fill("Password", { from: "secret", key: "scratch.password" }),
            click("Continue"),
          ],
          seen: 1,
        },
        {
          name: "your-details",
          looks: "details",
          url: "site.test/details",
          landmarks: ["heading your details"],
          ops: [
            fill("Company", { from: "plan", field: "company" }),
            fill("Start", { from: "plan", field: "start" }),
            {
              kind: "select",
              goal: "choose {size}",
              hints: hints("combobox", "Size"),
              value: "{size}",
            },
            { ...click("Next", true), hints: hints("button", "Next") },
          ],
          seen: 1,
        },
      ],
    });
  const now = () => new Date(2026, 9, 5, 9, 0);

  it("fills profile values, defaults, today+Nd and {field} refs; asks a field with no default", async () => {
    const { fp, log } = fakeSite(SITE, "other");
    const asked: string[] = [];
    await walkFlow(v2(), {
      secrets,
      now,
      profile: async (f) => (f === "email" ? "b@site.test" : null),
      ask: async (f) => {
        asked.push(f.key);
        return "51-200";
      },
    }).run(fp, {});
    expect(asked).toEqual(["size"]);
    expect(log).toEqual([
      "open https://site.test/signup?ref=ad",
      "fill Email = b@site.test",
      "fill Password = fake-pw-1",
      "click Continue",
      "fill Company = Acme",
      "fill Start = 10/08/2026",
      "select Size = 51-200",
      "click Next (irreversible)",
    ]);
  });

  it("takes --plan over a default; a v2 walk never runs on the example; v1 still does", async () => {
    const run = async (w: WalkSpec, input: Record<string, string>) => {
      const { fp, log } = fakeSite(SITE, "other");
      await walkFlow(w, { secrets, now, profile: async () => "b@site.test" })
        .run(fp, input)
        .catch((e: Error) => log.push(`human: ${e.message}`));
      return log;
    };
    const two = await run(v2(), { company: "Globex" });
    expect(two).toContain("fill Company = Globex");
    expect(two.at(-1)).toMatch(/^human: .*no size given/);
    const one = await run({ ...v2(), version: 1 }, {});
    expect(one).toContain("select Size = 11-50");
  });
});
