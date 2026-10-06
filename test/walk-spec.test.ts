import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listWalks,
  loadWalk,
  saveWalk,
  type WalkSpec,
  walkFile,
  walkOpSchema,
  walkSpecSchema,
} from "../src/walks/spec.js";

const tmp = () => mkdtempSync(join(tmpdir(), "autobrowse-walk-spec-"));

const spec = (o: Partial<WalkSpec> = {}): WalkSpec => ({
  version: 1,
  site: "scratch",
  name: "join-list",
  goal: "join the list",
  built: "2026-09-30T12:00:00.000Z",
  from: [{ run: "20260930-120000-aaaa", outcome: "achieved", endedAt: "2026-09-30T12:05:00.000Z" }],
  start: "https://site.test/signup",
  fields: [{ key: "email", label: "Email", example: "a@site.test" }],
  secrets: [{ key: "scratch.password", label: "Password" }],
  irreversible: false,
  screens: [
    {
      name: "join-list-done",
      looks: "heading welcome on site.test/welcome",
      url: "site.test/welcome",
      landmarks: ["heading welcome"],
      ops: [],
      goal: true,
      seen: 1,
    },
    {
      name: "sign-up",
      looks: "heading sign up on site.test/signup",
      url: "site.test/signup",
      landmarks: ["heading sign up", "field email"],
      ops: [
        {
          kind: "fill",
          goal: "fill Email",
          hints: { role: "textbox", name: "Email" },
          value: { from: "plan", field: "email" },
        },
        {
          kind: "fill",
          goal: "fill Password",
          hints: { role: "textbox", name: "Password" },
          value: { from: "secret", key: "scratch.password" },
        },
        {
          kind: "click",
          goal: "click Continue",
          hints: { role: "button", name: "Continue" },
          irreversible: false,
        },
      ],
      seen: 1,
    },
  ],
  ...o,
});

const issues = (w: unknown): string[] => {
  const r = walkSpecSchema.safeParse(w);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

const screen = (i: number, w: WalkSpec = spec()) => w.screens[i] as WalkSpec["screens"][number];

describe("walkSpecSchema", () => {
  it("takes a well-formed walk", () => {
    expect(issues(spec())).toEqual([]);
  });

  it("wants unique screen names", () => {
    const w = spec();
    w.screens.push({ ...screen(1, w), ops: [] });
    expect(issues(w)).toContain("not unique");
  });

  it("wants a goal screen that does nothing", () => {
    const w = spec();
    screen(0, w).ops = [{ kind: "human", reason: "x" }];
    expect(issues(w)).toContain("a goal does nothing");
  });

  it("wants at least one goal", () => {
    const w = spec();
    w.screens = [screen(1, w)];
    expect(issues(w)).toContain("no goal screen");
  });

  it("wants at least one screen", () => {
    expect(issues(spec({ screens: [] })).length).toBeGreaterThan(0);
  });

  it("wants every after to name a screen", () => {
    const w = spec();
    screen(0, w).after = ["sign-up", "nowhere"];
    expect(issues(w)).toEqual(["names no screen: nowhere"]);
  });

  it("wants plan fields and secrets declared", () => {
    expect(issues(spec({ fields: [] }))).toEqual(["field email is not declared"]);
    expect(issues(spec({ secrets: [] }))).toEqual(["secret scratch.password is not declared"]);
    const w = spec();
    screen(1, w).ops.push({
      kind: "upload",
      goal: "upload",
      hints: { role: "button", name: "Upload" },
      file: { from: "plan", field: "resumeFile" },
    });
    expect(issues(w)).toEqual(["field resumeFile is not declared"]);
  });

  it("takes secret keys the explore server places, and no others", () => {
    for (const key of ["code", "google.password", "google-admin.code", "google@ops.password"])
      expect(
        issues(
          spec({
            secrets: [{ key, label: "x" }],
            screens: spec().screens.map((s) => ({
              ...s,
              ops: s.ops.map((o) =>
                o.kind === "fill" && o.value.from === "secret"
                  ? { ...o, value: { from: "secret" as const, key } }
                  : o,
              ),
            })),
          }),
        ),
        key,
      ).toEqual([]);
    for (const key of ["Password", "a..b", "1code", "a b", ".x"])
      expect(issues(spec({ secrets: [{ key, label: "x" }] })).length, key).toBeGreaterThan(0);
  });

  it("checks names, site and version", () => {
    expect(issues(spec({ name: "Join_List" })).length).toBeGreaterThan(0);
    expect(issues(spec({ site: "../x" })).length).toBeGreaterThan(0);
    expect(issues({ ...spec(), version: 3 }).length).toBeGreaterThan(0);
    expect(issues(spec({ start: "not a url" })).length).toBeGreaterThan(0);
    expect(issues(spec({ start: null }))).toEqual([]);
  });

  it("takes walk ops by name or site/name", () => {
    const ok = (walk: string) =>
      walkOpSchema.safeParse({ kind: "walk", goal: "sign in", walk }).success;
    expect(ok("sign-in")).toBe(true);
    expect(ok("google/sign-in")).toBe(true);
    expect(ok("google.com/sign-in")).toBe(true);
    expect(ok("../sign-in")).toBe(false);
    expect(ok("google/sign-in/x")).toBe(false);
    expect(ok("Sign-In")).toBe(false);
    expect(walkOpSchema.safeParse({ kind: "open", goal: "o", url: "nope" }).success).toBe(false);
    expect(walkOpSchema.safeParse({ kind: "captcha", goal: "c" }).success).toBe(true);
    expect(walkOpSchema.safeParse({ kind: "open", goal: "o", url: "{link}" }).success).toBe(true);
    expect(walkOpSchema.safeParse({ kind: "open", goal: "o", url: "x{link}" }).success).toBe(false);
  });

  it("wants an each over a records op's rows or a declared field", () => {
    const withEach = (over: string, before: WalkSpec["screens"][number]["ops"] = []) => {
      const w = spec();
      screen(1, w).ops = [
        ...before,
        { kind: "each", goal: "each ad", over, walk: "ad", as: "detail" },
      ];
      return w;
    };
    expect(issues(withEach("email"))).toEqual([]);
    expect(issues(withEach("ads"))).toEqual([
      "ads is neither a records op's rows nor a declared field",
    ]);
    const rows = {
      kind: "records" as const,
      goal: "ads",
      as: "ads",
      fields: [{ key: "link", says: "its page" }],
      key: "link",
      code: "return []",
      min: 0,
      sample: [],
    };
    expect(issues(withEach("ads", [rows]))).toEqual([]);
  });
});

describe("walkFile", () => {
  it("files a walk under its base site, kebab names only", () => {
    expect(walkFile("/w", "google@ops", "sign-in")).toBe(join("/w", "google", "sign-in.json"));
    expect(() => walkFile("/w", "../x", "sign-in")).toThrow(/cannot name a walks folder/);
    expect(() => walkFile("/w", "google", "../x")).toThrow(/is not a walk name/);
    expect(() => walkFile("/w", "google", "Sign_In")).toThrow(/is not a walk name/);
  });
});

describe("saveWalk / loadWalk / listWalks", () => {
  it("saves whole, owner-only, and loads it back", () => {
    const dir = tmp();
    const file = saveWalk(dir, spec({ site: "scratch" }));
    expect(file).toBe(join(dir, "scratch", "join-list.json"));
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "scratch")).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, "utf8").endsWith("}\n")).toBe(true);
    expect(loadWalk(dir, "scratch", "join-list")).toEqual(spec());
    expect(loadWalk(dir, "other", "scratch/join-list")).toEqual(spec());
    expect(loadWalk(dir, "scratch@ops", "join-list")).toEqual(spec());
  });

  it("refuses a site@account in the spec: a built walk carries the base site", () => {
    const dir = tmp();
    expect(() => saveWalk(dir, spec({ site: "google@ops" }))).toThrow();
  });

  it("refuses to save a walk that breaks the schema", () => {
    const dir = tmp();
    expect(() => saveWalk(dir, spec({ fields: [] }))).toThrow(/field email is not declared/);
    expect(existsSync(join(dir, "scratch"))).toBe(false);
  });

  it("is null for a walk that is not there", () => {
    const dir = tmp();
    expect(loadWalk(dir, "scratch", "nope")).toBeNull();
    expect(loadWalk(join(dir, "missing"), "scratch", "nope")).toBeNull();
  });

  it("throws on a hand edit that breaks the schema, naming the walk", () => {
    const dir = tmp();
    const file = saveWalk(dir, spec());
    const w = JSON.parse(readFileSync(file, "utf8"));
    w.screens[0].ops = [{ kind: "human", reason: "x" }];
    writeFileSync(file, JSON.stringify(w));
    expect(() => loadWalk(dir, "scratch", "join-list")).toThrow(
      "walk scratch/join-list: a goal does nothing",
    );
  });

  it("lists walks by site then name; a broken one is listed with its error", () => {
    const dir = tmp();
    saveWalk(dir, spec({ site: "zeta", name: "b-walk" }));
    saveWalk(dir, spec({ site: "zeta", name: "a-walk", irreversible: true }));
    saveWalk(dir, spec({ site: "alpha", name: "c-walk" }));
    writeFileSync(join(dir, "alpha", "broken.json"), JSON.stringify({ version: 1 }));
    writeFileSync(join(dir, "alpha", "notes.txt"), "x");
    writeFileSync(join(dir, "stray.json"), "{}");
    mkdirSync(join(dir, "empty"));
    const all = listWalks(dir);
    expect(all.map((w) => `${w.site}/${w.name}`)).toEqual([
      "alpha/broken",
      "alpha/c-walk",
      "zeta/a-walk",
      "zeta/b-walk",
    ]);
    expect(all[0]).toMatchObject({ screens: 0, runs: 0, irreversible: true, built: "" });
    expect(all[0]?.goal).toMatch(/^\(broken: walk alpha\/broken: /);
    expect(all[1]).toEqual({
      site: "alpha",
      name: "c-walk",
      goal: "join the list",
      screens: 2,
      runs: 1,
      irreversible: false,
      built: "2026-09-30T12:00:00.000Z",
    });
    expect(all[2]?.irreversible).toBe(true);
  });

  it("lists a file that is not JSON as broken too", () => {
    const dir = tmp();
    mkdirSync(join(dir, "scratch"));
    writeFileSync(join(dir, "scratch", "cut.json"), '{"version":1,');
    const [w] = listWalks(dir);
    expect(w?.name).toBe("cut");
    expect(w?.goal).toMatch(/^\(broken: /);
  });

  it("is empty for a missing folder", () => {
    expect(listWalks(join(tmp(), "none"))).toEqual([]);
  });
});

describe("walk spec v2", () => {
  it("still loads a v1 walk file as it was written", () => {
    const dir = tmp();
    mkdirSync(join(dir, "scratch"), { recursive: true });
    writeFileSync(
      join(dir, "scratch", "join-list.json"),
      readFileSync(join(import.meta.dirname, "fixtures", "walk-v1.json"), "utf8"),
    );
    const w = loadWalk(dir, "scratch", "join-list");
    expect(w?.version).toBe(1);
    expect(w?.fields).toEqual([{ key: "who", label: "who", example: null }]);
  });

  it("takes profile values, defaults and {field} refs; refuses a ref to no field", () => {
    const v2 = spec({
      version: 2,
      fields: [{ key: "project", label: "Project", example: null, default: "today+3d" }],
      screens: [
        ...spec().screens.slice(0, 1),
        {
          name: "sign-up",
          looks: "sign up",
          url: "site.test/signup",
          landmarks: [],
          ops: [
            {
              kind: "fill",
              goal: "fill Email",
              hints: { role: "textbox", name: "Email" },
              value: { from: "profile", field: "email" },
            },
            { kind: "open", goal: "open project", url: "https://site.test/p/%7Bproject%7D" },
          ],
          seen: 1,
        },
      ],
    });
    expect(walkSpecSchema.safeParse(v2).success).toBe(true);
    const bad = structuredClone(v2);
    bad.fields = [];
    expect(walkSpecSchema.safeParse(bad).success).toBe(false);
    const noField = structuredClone(v2);
    (noField.screens[1]?.ops[0] as { value: unknown }).value = { from: "profile", field: "ssn" };
    expect(walkSpecSchema.safeParse(noField).success).toBe(false);
  });
});
