import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PageLook } from "../src/browser/screens.js";
import type { Action, LocatorHints } from "../src/recorder/types.js";
import { type RunOutcome, type RunRow, type RunSummary, runLog } from "../src/runs/log.js";
import {
  buildWalk,
  type RunInput,
  samePage,
  shows,
  USABLE,
  visitsOf,
  walkFromRuns,
} from "../src/walks/build.js";
import { saveWalk, walkSpecSchema } from "../src/walks/spec.js";

const tmp = () => mkdtempSync(join(tmpdir(), "autobrowse-walk-build-"));

const SIGNUP_URL = "https://site.test/signup";
const SIGNUP: PageLook = {
  url: "site.test/signup",
  landmarks: ["button continue", "heading join the list", "field email", "field name"],
};
const DETAILS: PageLook = {
  url: "site.test/details",
  landmarks: ["heading your details", "field company", "button next"],
};
const DONE: PageLook = {
  url: "site.test/welcome",
  landmarks: ["button home", "heading you're in"],
};
const OTHER: PageLook = { url: "site.test/other", landmarks: ["heading somewhere else"] };

const H = (role: string, name: string, extra: Partial<LocatorHints> = {}): LocatorHints => ({
  tag: role === "button" ? "button" : "input",
  role,
  name,
  text: null,
  placeholder: null,
  id: null,
  testId: null,
  href: null,
  inputType: null,
  ...extra,
});

const A = {
  navigate: (url = SIGNUP_URL): Action => ({ kind: "navigate", t: 0, url }),
  click: (name: string, extra: Partial<LocatorHints> = {}): Action => ({
    kind: "click",
    t: 0,
    url: SIGNUP_URL,
    target: H("button", name, extra),
  }),
  input: (
    name: string,
    value: string,
    o: { secret?: string; redacted?: boolean } = {},
  ): Action => ({
    kind: "input",
    t: 0,
    url: SIGNUP_URL,
    target: H("textbox", name),
    value,
    redacted: o.redacted ?? false,
    ...(o.secret ? { secret: o.secret } : {}),
  }),
  note: (text: string): Action => ({ kind: "note", t: 0, url: SIGNUP_URL, text }),
  pause: (): Action => ({ kind: "pause", t: 0, url: SIGNUP_URL }),
  resume: (): Action => ({ kind: "resume", t: 0, url: SIGNUP_URL }),
  submit: (): Action => ({ kind: "submit", t: 0, url: SIGNUP_URL, target: H("form", "f") }),
  read: (name: string, as: string): Action => ({
    kind: "read",
    t: 0,
    url: SIGNUP_URL,
    target: H("text", name),
    as,
    value: "secret-ish text",
  }),
  keep: (name: string, env: string): Action => ({
    kind: "keep",
    t: 0,
    url: SIGNUP_URL,
    target: H("text", name),
    env,
  }),
  select: (name: string, value: string): Action => ({
    kind: "select",
    t: 0,
    url: SIGNUP_URL,
    target: H("combobox", name),
    value,
  }),
  press: (name: string, key: string): Action => ({
    kind: "press",
    t: 0,
    url: SIGNUP_URL,
    target: H("textbox", name),
    key,
  }),
  upload: (name: string, file: string): Action => ({
    kind: "upload",
    t: 0,
    url: SIGNUP_URL,
    target: H("button", name),
    files: [file],
  }),
  desktop: (): Action =>
    ({ kind: "desktop", t: 0, url: "", op: { kind: "key" }, redacted: false }) as unknown as Action,
};

let tick = 0;
const at = () => new Date(Date.UTC(2026, 8, 30, 12, 0, 0) + tick++ * 1000).toISOString();
const act = (a: Action, look: PageLook | null, hand = false): RunRow => ({
  kind: "act",
  at: at(),
  act: a,
  look,
  ...(hand ? { hand: true as const } : {}),
});
const end = (look: PageLook | null, outcome: RunOutcome = "achieved"): RunRow => ({
  kind: "end",
  at: at(),
  outcome,
  summary: null,
  look,
});

const summary = (
  run: string,
  endedAt: string,
  goal: string | null = "join the list",
): RunSummary => ({
  run,
  site: "scratch",
  driver: "console",
  goal,
  outcome: "achieved",
  summary: null,
  startedAt: endedAt,
  endedAt,
  cmds: 0,
  acts: 0,
  tokens: 0,
  full: 0,
});
const R1 = "20260930-120000-aaaa";
const R2 = "20260930-130000-bbbb";
const input = (run: string, endedAt: string, rows: RunRow[], goal?: string): RunInput => ({
  summary: summary(run, endedAt, goal),
  rows,
});

const joinRun = (email: string, o: { name?: string; company?: string } = {}): RunRow[] => [
  act(A.navigate(), null),
  act(A.input("Email", email), SIGNUP),
  act(A.input("Name", o.name ?? "Ada"), SIGNUP),
  act(A.click("Continue"), SIGNUP),
  act(A.input("Company", o.company ?? "Acme"), DETAILS),
  act(A.click("Next"), DETAILS),
  end(DONE),
];

const opts = { site: "scratch", name: "join-list", now: new Date("2026-09-30T15:00:00.000Z") };

describe("samePage / shows", () => {
  it("is the same page on one URL with most landmarks shared", () => {
    expect(samePage(SIGNUP, { ...SIGNUP, landmarks: SIGNUP.landmarks.slice(0, 2) })).toBe(true);
    expect(
      samePage(SIGNUP, { ...SIGNUP, landmarks: ["heading join the list", "x", "y", "z"] }),
    ).toBe(false);
    expect(samePage(SIGNUP, { ...SIGNUP, url: "site.test/other" })).toBe(false);
    expect(samePage({ url: "a", landmarks: [] }, { url: "a", landmarks: [] })).toBe(true);
  });

  it("shows when every landmark is on the page and the URL fits", () => {
    expect(shows("site.test/signup", ["field email"], SIGNUP)).toBe(true);
    expect(shows(null, ["field email"], SIGNUP)).toBe(true);
    expect(shows("site.test/x", ["field email"], SIGNUP)).toBe(false);
    expect(shows(null, ["field phone"], SIGNUP)).toBe(false);
    expect(shows(null, [], SIGNUP)).toBe(true);
  });
});

describe("visitsOf", () => {
  it("cuts a run into visits by page; a leading navigate is the start", () => {
    const cut = visitsOf(R1, joinRun("a@site.test"));
    expect(cut.refused).toBeNull();
    expect(cut.start).toBe(SIGNUP_URL);
    expect(cut.end).toEqual(DONE);
    expect(cut.visits.map((v) => [v.look.url, v.ops.length])).toEqual([
      ["site.test/signup", 3],
      ["site.test/details", 2],
    ]);
  });

  it("makes a pause..resume one human op, named by the last note made while paused", () => {
    const cut = visitsOf(R1, [
      act(A.click("Continue"), SIGNUP),
      act(A.pause(), null),
      act(A.note("first"), null),
      act(A.input("Secret", "typed by hand"), null, true),
      act(A.note("type the code from the SMS"), null),
      act(A.resume(), null),
      act(A.pause(), null),
      act(A.resume(), null),
      end(DONE),
    ]);
    expect(cut.visits[0]?.ops).toEqual([
      { kind: "op", act: expect.objectContaining({ kind: "click" }) },
      { kind: "human", reason: "type the code from the SMS" },
      { kind: "human", reason: "a person acted here by hand (the run paused)" },
    ]);
    // A note while paused never names the next screen.
    expect(cut.visits[0]?.named).toBeNull();
  });

  it("makes a captcha note a captcha op, on a new visit when the page changed", () => {
    const cut = visitsOf(R1, [
      act(A.click("Continue"), SIGNUP),
      act(A.note("solved a captcha here (checkbox)"), SIGNUP),
      act(A.note("solved a captcha here"), OTHER),
      end(DONE),
    ]);
    expect(cut.visits.map((v) => [v.look.url, v.ops.map((o) => o.kind)])).toEqual([
      ["site.test/signup", ["op", "captcha"]],
      ["site.test/other", ["captcha"]],
    ]);
  });

  it("skips a load a person caused and submits; a later command's navigate is an open", () => {
    const cut = visitsOf(R1, [
      act(A.navigate(), null),
      act(A.click("Continue"), SIGNUP),
      act(A.navigate("https://site.test/details"), null, true),
      act(A.submit(), SIGNUP),
      act(A.navigate("https://site.test/other?x=1"), null),
      end(DONE),
    ]);
    expect(cut.start).toBe(SIGNUP_URL);
    expect(cut.visits[0]?.ops).toEqual([
      { kind: "op", act: expect.objectContaining({ kind: "click" }) },
      { kind: "open", url: "https://site.test/other?x=1" },
    ]);
  });

  it("refuses a run with a desktop act", () => {
    const cut = visitsOf(R1, [act(A.click("Continue"), SIGNUP), act(A.desktop(), null), end(DONE)]);
    expect(cut.refused).toBe("a desktop act (compile its recording)");
    expect(cut.visits).toEqual([]);
    expect(cut.end).toEqual(DONE);
  });

  it("refuses a run with no act on a looked-at page; its first act's page is the start", () => {
    const cut = visitsOf(R1, [
      act(A.note("hello"), null),
      act(A.click("Continue"), null, true),
      end(null),
    ]);
    expect(cut.refused).toBe("no act on a page");
    expect(cut.start).toBe(SIGNUP_URL);
  });

  it("a short note names the visit that follows", () => {
    const cut = visitsOf(R1, [
      act(A.note("  enter the email  "), null),
      act(A.click("Continue"), SIGNUP),
    ]);
    expect(cut.visits[0]?.named).toBe("enter the email");
  });

  it("keeps a pause made before the first looked-at act", () => {
    const cut = visitsOf(R1, [
      act(A.navigate(), null),
      act(A.pause(), null),
      act(A.note("sign in by hand"), null),
      act(A.resume(), null),
      act(A.click("Continue"), SIGNUP),
      end(DONE),
    ]);
    const all = cut.visits.flatMap((v) => v.ops);
    expect(all).toContainEqual({ kind: "human", reason: "sign in by hand" });
  });
});

describe("walkFromRuns", () => {
  it("builds screens, plan fields and a goal from two runs; text that differs is a field", () => {
    const built = walkFromRuns(
      // Out of order on purpose: the newest is by endedAt.
      [
        input(R2, "2026-09-30T13:05:00.000Z", joinRun("b@site.test"), "join the list, newest"),
        input(R1, "2026-09-30T12:05:00.000Z", joinRun("a@site.test")),
      ],
      opts,
    );
    const s = built.spec;
    expect(walkSpecSchema.safeParse(s).success).toBe(true);
    expect(built.used).toEqual([R1, R2]);
    expect(built.skipped).toEqual([]);
    expect(built.disagreements).toEqual([]);
    expect(s).toMatchObject({
      version: 2,
      site: "scratch",
      name: "join-list",
      goal: "join the list, newest",
      built: "2026-09-30T15:00:00.000Z",
      start: SIGNUP_URL,
      irreversible: false,
      secrets: [],
      fields: [{ key: "email", label: "Email", example: "b@site.test" }],
      from: [
        { run: R1, outcome: "achieved", endedAt: "2026-09-30T12:05:00.000Z" },
        { run: R2, outcome: "achieved", endedAt: "2026-09-30T13:05:00.000Z" },
      ],
    });
    expect(s.screens.map((x) => x.name)).toEqual([
      "join-list-done",
      "join-the-list",
      "your-details",
    ]);
    const [goal, signup, details] = s.screens;
    expect(goal).toEqual({
      name: "join-list-done",
      looks: "heading you're in on site.test/welcome",
      url: "site.test/welcome",
      landmarks: ["heading you're in", "button home"],
      ops: [],
      goal: true,
      seen: 2,
    });
    expect(signup).toMatchObject({
      url: "site.test/signup",
      looks: "heading join the list on site.test/signup",
      landmarks: ["heading join the list", "field email", "field name", "button continue"],
      seen: 2,
    });
    expect(signup?.after).toBeUndefined();
    expect(signup?.ops).toEqual([
      {
        kind: "fill",
        goal: "fill Email",
        hints: expect.objectContaining({ role: "textbox", name: "Email" }),
        value: { from: "plan", field: "email" },
      },
      {
        kind: "fill",
        goal: "fill Name",
        hints: expect.objectContaining({ name: "Name" }),
        value: { from: "literal", text: "Ada" },
      },
      {
        kind: "click",
        goal: "click Continue",
        hints: expect.objectContaining({ role: "button", name: "Continue" }),
        irreversible: false,
      },
    ]);
    // href is not a locator: stripped.
    expect(
      signup?.ops[0] && "hints" in signup.ops[0] ? signup.ops[0].hints : {},
    ).not.toHaveProperty("href");
    expect(details?.ops[0]).toMatchObject({ value: { from: "literal", text: "Acme" } });
  });

  it("makes every typed value a field when one run is all there is", () => {
    const s = walkFromRuns(
      [input(R1, "2026-09-30T12:05:00.000Z", joinRun("a@site.test"))],
      opts,
    ).spec;
    expect(s.fields.map((f) => [f.key, f.example])).toEqual([
      ["email", "a@site.test"],
      ["name", "Ada"],
      ["company", "Acme"],
    ]);
  });

  it("names fields apart when two controls share a label", () => {
    const rows = [
      act(A.input("Email", "a@site.test"), SIGNUP),
      act(A.input("Email", "again@site.test"), SIGNUP),
      end(DONE),
    ];
    const s = walkFromRuns([input(R1, "2026-09-30T12:05:00.000Z", rows)], opts).spec;
    expect(s.fields.map((f) => f.key)).toEqual(["email", "email2"]);
  });

  it("makes a placed secret a secret by its name, and a redacted value one by its label", () => {
    const rows = [
      act(A.input("Password", "", { secret: "scratch.password", redacted: true }), SIGNUP),
      act(A.input("Password", "", { secret: "scratch.password", redacted: true }), SIGNUP),
      act(A.input("API token", "", { redacted: true }), SIGNUP),
      end(DONE),
    ];
    const s = walkFromRuns([input(R1, "2026-09-30T12:05:00.000Z", rows)], opts).spec;
    expect(s.secrets).toEqual([
      { key: "scratch.password", label: "Password" },
      { key: "apiToken", label: "API token" },
    ]);
    expect(s.fields).toEqual([]);
    expect(s.screens[1]?.ops.map((o) => (o.kind === "fill" ? o.value : null))).toEqual([
      { from: "secret", key: "scratch.password" },
      { from: "secret", key: "scratch.password" },
      { from: "secret", key: "apiToken" },
    ]);
  });

  it("marks a walk irreversible when a click creates, sends or pays", () => {
    const rows = [act(A.click("Create account"), SIGNUP), end(DONE)];
    const s = walkFromRuns([input(R1, "2026-09-30T12:05:00.000Z", rows)], opts).spec;
    expect(s.irreversible).toBe(true);
    expect(s.screens[1]?.ops[0]).toMatchObject({ kind: "click", irreversible: true });
  });

  it("turns every other act into its op; an upload's file is a plan field", () => {
    const rows = [
      act(A.select("Plan", "Pro"), SIGNUP),
      act(A.press("Email", "Enter"), SIGNUP),
      act(A.upload("Resume", "/tmp/fake-resume.pdf"), SIGNUP),
      act(A.read("Order number", "orderNumber"), SIGNUP),
      act(A.keep("API key", "SCRATCH_API_KEY"), SIGNUP),
      end(DONE),
    ];
    const s = walkFromRuns([input(R1, "2026-09-30T12:05:00.000Z", rows)], opts).spec;
    expect(s.screens[1]?.ops.map((o) => o.kind)).toEqual([
      "select",
      "press",
      "upload",
      "read",
      "keep",
    ]);
    expect(s.screens[1]?.ops).toEqual([
      expect.objectContaining({ kind: "select", goal: "choose Pro", value: "Pro" }),
      expect.objectContaining({ kind: "press", goal: "press Enter", key: "Enter" }),
      expect.objectContaining({ kind: "upload", file: { from: "plan", field: "resumeFile" } }),
      expect.objectContaining({ kind: "read", as: "orderNumber" }),
      expect.objectContaining({ kind: "keep", env: "SCRATCH_API_KEY" }),
    ]);
    expect(s.fields).toEqual([
      { key: "resumeFile", label: "file for Resume", example: "/tmp/fake-resume.pdf" },
    ]);
  });

  it("makes ops of pauses, captchas and opens", () => {
    const rows = [
      act(A.click("Continue"), SIGNUP),
      act(A.note("solved a captcha here"), SIGNUP),
      act(A.pause(), null),
      act(A.note("type the code"), null),
      act(A.resume(), null),
      act(A.navigate("https://site.test/other?ref=1"), null),
      end(DONE),
    ];
    const s = walkFromRuns([input(R1, "2026-09-30T12:05:00.000Z", rows)], opts).spec;
    expect(s.screens[1]?.ops.slice(1)).toEqual([
      { kind: "captcha", goal: "solve the captcha" },
      { kind: "human", reason: "type the code" },
      { kind: "open", goal: "open site.test/other", url: "https://site.test/other?ref=1" },
    ]);
  });

  it("names a screen by a short note before it, and describes it by a long one", () => {
    const long = "this is the page where the site asks for everything about you and your company";
    const rows = [
      act(A.note("enter the email"), null),
      act(A.click("Continue"), SIGNUP),
      act(A.note(long), null),
      act(A.click("Next"), DETAILS),
      end(DONE),
    ];
    const s = walkFromRuns([input(R1, "2026-09-30T12:05:00.000Z", rows)], opts).spec;
    expect(s.screens.map((x) => x.name)).toEqual([
      "join-list-done",
      "enter-the-email",
      "your-details",
    ]);
    expect(s.screens[2]?.looks).toBe(long);
  });

  it("makes a second visit to a page its own screen, after the first", () => {
    const rows = [
      act(A.click("Continue"), SIGNUP),
      act(A.click("Next"), DETAILS),
      act(A.click("Continue"), SIGNUP),
      end(DONE),
    ];
    const s = walkFromRuns([input(R1, "2026-09-30T12:05:00.000Z", rows)], opts).spec;
    expect(s.screens.map((x) => x.name)).toEqual([
      "join-list-done",
      "join-the-list",
      "your-details",
      "join-the-list-2",
    ]);
    expect(s.screens[3]?.after).toContain("join-the-list");
    expect(s.screens[1]?.after).toBeUndefined();
  });

  it("makes a goal page passed on the way the goal only after the last screen", () => {
    const rows = [act(A.click("Continue"), SIGNUP), act(A.click("Next"), DETAILS), end(SIGNUP)];
    const s = walkFromRuns([input(R1, "2026-09-30T12:05:00.000Z", rows)], opts).spec;
    expect(s.screens[0]).toMatchObject({
      goal: true,
      url: "site.test/signup",
      after: ["your-details"],
    });
  });

  it("with no end look, the goal is whatever page the last screen leads to", () => {
    const rows = [act(A.click("Continue"), SIGNUP), act(A.click("Next"), DETAILS), end(null)];
    const s = walkFromRuns([input(R1, "2026-09-30T12:05:00.000Z", rows)], opts).spec;
    expect(s.screens[0]).toEqual({
      name: "join-list-done",
      looks: "whatever page the last screen leads to",
      url: null,
      landmarks: [],
      ops: [],
      goal: true,
      after: ["your-details"],
      seen: 0,
    });
  });

  it("names the goal from the walk name, without walk- and apart from other screens", () => {
    const rows = [act(A.note("join list done"), null), act(A.click("Continue"), SIGNUP), end(DONE)];
    const s = walkFromRuns([input(R1, "2026-09-30T12:05:00.000Z", rows)], {
      ...opts,
      name: "walk-join-list",
    }).spec;
    expect(s.name).toBe("walk-join-list");
    expect(s.screens.map((x) => x.name)).toEqual(["join-list-done-2", "join-list-done"]);
  });

  it("says where the runs disagree and keeps the newest", () => {
    const old = [
      act(A.input("Email", "a@site.test"), SIGNUP),
      act(A.input("Name", "Ada"), SIGNUP),
      act(A.click("Continue"), SIGNUP),
      end(OTHER),
    ];
    const built = walkFromRuns(
      [
        input(R1, "2026-09-30T12:05:00.000Z", old),
        input(R2, "2026-09-30T13:05:00.000Z", joinRun("b@site.test")),
      ],
      opts,
    );
    expect(built.disagreements).toEqual([
      `goal: run ${R1} ended on site.test/other, the newest on site.test/welcome; kept the newest's`,
    ]);
    const fewer = [act(A.click("Continue"), SIGNUP), end(DONE)];
    const b2 = walkFromRuns(
      [
        input(R1, "2026-09-30T12:05:00.000Z", joinRun("a@site.test")),
        input(R2, "2026-09-30T13:05:00.000Z", fewer),
      ],
      opts,
    );
    expect(b2.disagreements).toEqual([
      `join-the-list: op 1 was "input Email" in run ${R1}, "click Continue" in ${R2}; kept ${R2}'s`,
    ]);
    expect(b2.spec.screens.find((x) => x.name === "join-the-list")?.ops).toHaveLength(1);
    // The page only the older run saw is still a screen, seen once.
    expect(b2.spec.screens.find((x) => x.name === "your-details")?.seen).toBe(1);
  });

  it("says where the runs clicked different things on the same screen", () => {
    const one = (button: string) => [act(A.click(button), SIGNUP), end(DONE)];
    const built = walkFromRuns(
      [
        input(R1, "2026-09-30T12:05:00.000Z", one("Skip")),
        input(R2, "2026-09-30T13:05:00.000Z", one("Continue")),
      ],
      opts,
    );
    expect(built.disagreements.length).toBeGreaterThan(0);
  });

  it("keeps the iframe an act's element was in", () => {
    const rows = [act(A.click("Sign in with Google", { frame: "iframe#gsi" }), SIGNUP), end(DONE)];
    const s = walkFromRuns([input(R1, "2026-09-30T12:05:00.000Z", rows)], opts).spec;
    const op = s.screens[1]?.ops[0];
    expect(op && "hints" in op ? op.hints : null).toMatchObject({ frame: "iframe#gsi" });
  });

  it("skips runs that cannot make a walk, and throws when none can", () => {
    const desk = [act(A.click("Continue"), SIGNUP), act(A.desktop(), null), end(DONE)];
    const built = walkFromRuns(
      [
        input(R1, "2026-09-30T12:05:00.000Z", desk),
        input(R2, "2026-09-30T13:05:00.000Z", joinRun("b@site.test")),
      ],
      opts,
    );
    expect(built.used).toEqual([R2]);
    expect(built.skipped).toEqual([{ run: R1, reason: "a desktop act (compile its recording)" }]);
    expect(() => walkFromRuns([input(R1, "2026-09-30T12:05:00.000Z", desk)], opts)).toThrow(
      `no run can make join-list: ${R1} (a desktop act (compile its recording))`,
    );
    expect(() => walkFromRuns([], opts)).toThrow("no run can make join-list");
  });

  it("falls back to a goal in words from the walk and site", () => {
    const s = walkFromRuns(
      [{ summary: summary(R1, "2026-09-30T12:05:00.000Z", null), rows: joinRun("a@site.test") }],
      { ...opts, site: "scratch@ops" },
    ).spec;
    expect(s.goal).toBe("join-list on scratch");
    expect(s.site).toBe("scratch");
    const given = walkFromRuns([input(R1, "2026-09-30T12:05:00.000Z", joinRun("a@site.test"))], {
      ...opts,
      goal: "sign up for the list",
    }).spec;
    expect(given.goal).toBe("sign up for the list");
  });

  it("builds a walk saveWalk takes", () => {
    const s = walkFromRuns(
      [input(R1, "2026-09-30T12:05:00.000Z", joinRun("a@site.test"))],
      opts,
    ).spec;
    expect(() => saveWalk(tmp(), s)).not.toThrow();
  });
});

describe("buildWalk", () => {
  /** A run on disk, as the explore server writes it. */
  const writeRun = (
    dir: string,
    site: string,
    goal: string,
    outcome: RunOutcome,
    rows: RunRow[],
    startAt: string,
  ): string => {
    let t = Date.parse(startAt);
    const log = runLog(dir, site, {
      now: () => {
        t += 1000;
        return new Date(t);
      },
    });
    log.start({
      run: log.id,
      site,
      driver: "console",
      goal,
      machine: "box",
      resumed: false,
      viewport: null,
    });
    let endRow: Extract<RunRow, { kind: "end" }> | null = null;
    for (const r of rows)
      if (r.kind === "act") log.act(r.act, r.look, r.hand === true);
      else if (r.kind === "end") endRow = r;
    log.end({ outcome, summary: null, look: endRow?.look ?? null });
    return log.id;
  };

  it("wants runs or a goal they share", () => {
    expect(() => buildWalk(tmp(), { site: "scratch", name: "x" })).toThrow(/--run.*--goal-like/);
  });

  it("picks usable runs on the site whose goal has every word; names the ones it skipped", () => {
    const dir = tmp();
    const r1 = writeRun(
      dir,
      "scratch",
      "Join the mailing LIST",
      "achieved",
      joinRun("a@site.test"),
      "2026-09-30T10:00:00Z",
    );
    const r2 = writeRun(
      dir,
      "scratch@ops",
      "join the list again",
      "saved",
      joinRun("b@site.test"),
      "2026-09-30T11:00:00Z",
    );
    const failed = writeRun(
      dir,
      "scratch",
      "join the list",
      "failed",
      joinRun("c@site.test"),
      "2026-09-30T12:00:00Z",
    );
    writeRun(
      dir,
      "other",
      "join the list",
      "achieved",
      joinRun("d@site.test"),
      "2026-09-30T13:00:00Z",
    );
    writeRun(
      dir,
      "scratch",
      "unsubscribe",
      "achieved",
      joinRun("e@site.test"),
      "2026-09-30T14:00:00Z",
    );

    const built = buildWalk(dir, { ...opts, goalLike: "join list" });
    expect(built.used).toEqual([r1, r2]);
    expect(built.skipped).toEqual([]);
    expect(built.spec.fields[0]).toMatchObject({ key: "email", example: "b@site.test" });

    const named = buildWalk(dir, { ...opts, runs: [r1, failed, "20260101-000000-dead"] });
    expect(named.used).toEqual([r1]);
    expect(named.skipped).toEqual([
      { run: "20260101-000000-dead", reason: "no ended run on scratch" },
      { run: failed, reason: "ended failed" },
    ]);
    expect([...USABLE].sort()).toEqual(["achieved", "saved"]);
  });

  it("throws when nothing usable matches", () => {
    const dir = tmp();
    writeRun(
      dir,
      "scratch",
      "join the list",
      "failed",
      joinRun("a@site.test"),
      "2026-09-30T10:00:00Z",
    );
    expect(() => buildWalk(dir, { ...opts, goalLike: "join" })).toThrow(
      /no run can make join-list/,
    );
  });
});

describe("taught by hand: where each value comes from", () => {
  const t0 = Date.UTC(2026, 9, 5, 12, 0, 0);
  const row = (s: number, a: Action, look: PageLook | null): RunRow => ({
    kind: "act",
    at: new Date(t0 + s * 1000).toISOString(),
    act: a,
    look,
    hand: true,
  });
  const P_URL = "https://site.test/p/4471";
  const PROJECT: PageLook = {
    url: "site.test/p/4471",
    landmarks: ["heading project", "link 4471"],
  };
  const rows: RunRow[] = [
    {
      kind: "start",
      at: new Date(t0).toISOString(),
      run: R1,
      site: "scratch",
      driver: "person",
      goal: "join the list",
      machine: "test",
      resumed: false,
      viewport: null,
    } as RunRow,
    row(1, A.navigate(), null),
    row(5, A.input("Name", "Ada Lovelace"), SIGNUP),
    row(6, A.input("Email", "ADA@site.test "), SIGNUP),
    row(7, A.input("Start date", "2026-10-08"), SIGNUP),
    row(8, A.input("Project", "4471"), SIGNUP),
    row(9, A.select("Size", "11-50"), SIGNUP),
    row(10, A.click("Continue"), SIGNUP),
    // The click's own load: not an op.
    row(11, A.navigate("https://site.test/details"), null),
    // Typed in the address bar a while later: an op.
    row(40, A.navigate(P_URL), DETAILS),
    row(45, { ...A.click("", { text: "4471" }), url: P_URL }, PROJECT),
    end(DONE),
  ];
  const built = walkFromRuns(
    [{ summary: { ...summary(R1, "2026-10-05T12:01:00.000Z"), driver: "person" }, rows }],
    {
      ...opts,
      now: new Date(t0),
      profile: { id: "ada", name: "Ada Lovelace", email: "ada@site.test" },
    },
  );
  const s = built.spec;
  const ops = s.screens.flatMap((x) => x.ops);

  it("takes profile values from the profile, dates as today+Nd, the rest as fields with a default", () => {
    expect(s.version).toBe(2);
    const fills = ops.flatMap((op) => (op.kind === "fill" ? [[op.goal, op.value]] : []));
    expect(fills).toEqual([
      ["fill Name", { from: "profile", field: "name" }],
      ["fill Email", { from: "profile", field: "email" }],
      ["fill Start date", { from: "plan", field: "startDate" }],
      ["fill Project", { from: "plan", field: "project" }],
    ]);
    expect(s.fields.map((f) => [f.key, f.default])).toEqual([
      ["startDate", "today+3d"],
      ["project", "4471"],
    ]);
    expect(built.guesses.map((g) => [g.label, g.why])).toEqual([
      ["Name", "your profile's name"],
      ["Email", "your profile's email"],
      ["Start date", "a date: today+3d"],
      ["Project", "an id in a URL it opens: asked each run, default as typed"],
      ["Size", "a choice: fixed"],
    ]);
  });

  it("makes an address-bar load an open op with the id as {field}; a click on that id follows it", () => {
    expect(ops.filter((op) => op.kind === "open")).toEqual([
      { kind: "open", goal: "open site.test/p/4471", url: "https://site.test/p/%7Bproject%7D" },
    ]);
    const picked = ops.find((op) => op.kind === "click" && op.goal === "click {project}");
    expect(picked?.kind === "click" && picked.hints.text).toBe("{project}");
    expect(s.start).toBe(SIGNUP_URL);
  });
});
