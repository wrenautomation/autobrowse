import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flowRunner } from "../src/browser/flow.js";
import { startExplore } from "../src/explore/server.js";
import { checkMod } from "../src/mods/install.js";
import { type Profile, profileField } from "../src/money/profile.js";
import { buildWalk, type Guess } from "../src/walks/build.js";
import { walkFlow } from "../src/walks/flow.js";
import type { WalkSpec } from "../src/walks/spec.js";
import { choose, looksPersonal, packInto, personalValues, review } from "../src/walks/teach.js";

const tmp = () => mkdtempSync(join(tmpdir(), "autobrowse-teach-"));

const spec = (): WalkSpec => ({
  version: 2,
  site: "scratch",
  name: "join-list",
  goal: "join the list",
  built: "2026-10-05T12:00:00.000Z",
  from: [{ run: "20261005-120000-aaaa", outcome: "achieved", endedAt: "2026-10-05T12:05:00.000Z" }],
  start: "https://site.test/signup",
  fields: [{ key: "note", label: "Note", example: "hello", default: "hello" }],
  secrets: [],
  irreversible: true,
  screens: [
    {
      name: "done",
      looks: "done",
      url: "site.test/done",
      landmarks: ["heading you are on the list"],
      ops: [],
      goal: true,
      seen: 1,
    },
    {
      name: "join",
      looks: "join",
      url: "site.test/signup",
      landmarks: ["heading join the list"],
      ops: [
        {
          kind: "fill",
          goal: "fill Email",
          hints: { role: "textbox", name: "Email" },
          value: { from: "profile", field: "email" },
        },
        {
          kind: "fill",
          goal: "fill Note",
          hints: { role: "textbox", name: "Note" },
          value: { from: "plan", field: "note" },
        },
        {
          kind: "select",
          goal: "choose 11-50",
          hints: { role: "combobox", name: "Size" },
          value: "11-50",
        },
        {
          kind: "click",
          goal: "click Confirm",
          hints: { role: "button", name: "Confirm" },
          irreversible: true,
        },
      ],
      seen: 1,
    },
  ],
});
const g = (op: number, label: string, typed: string | null): Guess => ({
  screen: "join",
  op,
  label,
  typed,
  why: "test",
});
const EMAIL = g(0, "Email", "ada@site.test");
const NOTE = g(1, "Note", "hello");
const SIZE = g(2, "Size", "11-50");
const opAt = (w: WalkSpec, i: number) => w.screens[1]?.ops[i];

describe("teach review", () => {
  it("moves a value between fixed, ask, profile and secret; unused fields go", () => {
    const fixed = choose(spec(), NOTE, { to: "fixed" });
    expect(opAt(fixed, 1)).toMatchObject({ value: { from: "literal", text: "hello" } });
    expect(fixed.fields).toEqual([]);
    const asked = choose(spec(), NOTE, { to: "ask" });
    expect(asked.fields).toEqual([{ key: "note", label: "Note", example: "hello" }]);
    const mine = choose(spec(), EMAIL, { to: "ask" });
    expect(opAt(mine, 0)).toMatchObject({ value: { from: "plan", field: "email" } });
    expect(
      choose(mine, g(0, "Email", "ada@site.test"), { to: "profile", field: "email" }).fields,
    ).toEqual(spec().fields);
    const hidden = choose(spec(), NOTE, { to: "secret" });
    expect(hidden.secrets).toEqual([{ key: "note", label: "Note" }]);
    const size = choose(spec(), SIZE, { to: "ask" });
    expect(opAt(size, 2)).toMatchObject({ value: "{size}" });
    expect(() => choose(spec(), SIZE, { to: "secret" })).toThrow(/a choice/);
  });

  it("reads one key per value; Enter keeps the guess, p asks which profile field", async () => {
    const answers = ["", "f", "zz", "a", ""];
    const said: string[] = [];
    const out = await review(spec(), [EMAIL, NOTE, SIZE], {
      say: (l) => said.push(l),
      ask: async (p) => {
        said.push(p);
        return answers.shift() ?? "";
      },
    });
    expect(opAt(out.spec, 1)).toMatchObject({ value: { from: "literal", text: "hello" } });
    expect(opAt(out.spec, 2)).toMatchObject({ value: "{size}" });
    expect(out.allowed).toEqual(["hello"]);
    expect(said.join("\n")).toContain('Email · "ada@site.test" · profile.email');
  });

  it("finds values that look personal and refuses to pack them unless allowed", () => {
    expect(looksPersonal("ada@site.test")).toBe(true);
    expect(looksPersonal("+1 (555) 010-0199")).toBe(true);
    expect(looksPersonal("12 Example Street")).toBe(true);
    expect(looksPersonal("11-50")).toBe(false);
    expect(looksPersonal("2026")).toBe(false);
    const w = choose(spec(), EMAIL, { to: "fixed" });
    expect(personalValues(w).map((p) => p.value)).toEqual(["ada@site.test"]);
    const dir = tmp();
    expect(() => packInto(dir, w, { version: "0.3.0" })).toThrow(/look personal/);
    const packed = packInto(dir, spec(), { version: "0.3.0" });
    const walk = JSON.parse(readFileSync(packed.file, "utf8")) as WalkSpec;
    expect(walk.from).toEqual([]);
    expect(walk.fields).toEqual([{ key: "note", label: "Note", example: null, default: "hello" }]);
    expect(packed.mod).toMatchObject({
      name: "autobrowse-mod-scratch",
      sites: ["scratch"],
      domains: ["site.test"],
      gates: ["send"],
      irreversible: true,
    });
    expect(checkMod(dir, { version: "0.3.0" }).name).toBe("autobrowse-mod-scratch");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("teach end to end", () => {
  const joined: Record<string, string>[] = [];
  const server = createServer((q, r) => {
    const u = new URL(q.url ?? "/", "http://x");
    const qs = Object.fromEntries(u.searchParams);
    const page = (body: string) =>
      r
        .writeHead(200, { "content-type": "text/html" })
        .end(`<!doctype html><title>t</title>${body}`);
    if (u.pathname === "/confirm")
      return page(
        `<h1>Check your details</h1><p>${Object.values(qs).join(" ").replace(/</g, "")}</p><form action="/done">${Object.entries(
          qs,
        )
          .map(([k, v]) => `<input type="hidden" name="${k}" value="${v.replace(/"/g, "")}">`)
          .join("")}<button>Confirm</button></form>`,
      );
    if (u.pathname === "/done") {
      joined.push(qs);
      return page("<h1>You are on the list</h1><p>Thanks.</p>");
    }
    return page(
      `<h1>Join the list</h1><form action="/confirm"><label for="name">Name</label><input id="name" name="name"><label for="email">Email</label><input id="email" name="email" type="email"><label for="note">Note</label><input id="note" name="note"><label for="size">Size</label><select id="size" name="size"><option>1-10</option><option>11-50</option></select><input type="radio" name="plan" value="paid" checked><span>Paid</span><input type="radio" name="plan" value="free"><span>Free</span><button>Continue</button></form>`,
    );
  });
  const browser = (dir: string) => ({
    tier: "local" as const,
    channel: "chromium" as const,
    profilesDir: join(dir, "profiles"),
    artifactsDir: join(dir, "artifacts"),
    headless: true,
  });
  /** A person at the keyboard: real DOM events, after the command that scheduled them has ended. */
  const byHand = (steps: string[]) =>
    steps.map((js, i) => `setTimeout(() => { ${js} }, ${1000 + i * 700});`).join("\n");
  const type = (id: string, v: string) =>
    `const i = document.getElementById('${id}'); i.focus(); i.value = '${v}'; i.dispatchEvent(new Event('input', {bubbles: true})); i.dispatchEvent(new Event('change', {bubbles: true}));`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("a join-list form done by hand replays as someone else, with another note", async () => {
    const dir = tmp();
    const runs = join(dir, "runs");
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const ada: Profile = { id: "ada", name: "Ada Lovelace", email: "ada@site.test" };
    const grace: Profile = { id: "grace", name: "Grace Hopper", email: "grace@site.test" };
    try {
      const ex = await startExplore({
        site: "scratch",
        port: 9800 + Math.floor(Math.random() * 150),
        recordingsDir: join(dir, "recordings"),
        runs,
        driver: "person",
        browser: browser(dir),
      });
      const run = ex.runId();
      try {
        await ex.exec({ cmd: "open", url });
        await ex.exec({
          cmd: "eval",
          js: byHand([
            type("name", "Ada Lovelace"),
            type("email", "ada@site.test"),
            type("note", "first"),
            "const s = document.getElementById('size'); s.value = '11-50'; s.dispatchEvent(new Event('change', {bubbles: true}));",
            "document.querySelectorAll('input[type=radio]')[1].click();",
            "document.querySelector('button').click();",
          ]),
        });
        await sleep(6_500);
        await ex.exec({ cmd: "eval", js: byHand(["document.querySelector('button').click();"]) });
        await sleep(2_500);
      } finally {
        await ex.exec({ cmd: "close" }).catch(() => undefined);
        await ex.done;
      }
      expect(joined).toEqual([
        {
          name: "Ada Lovelace",
          email: "ada@site.test",
          note: "first",
          size: "11-50",
          plan: "free",
        },
      ]);

      const built = buildWalk(runs, {
        site: "scratch",
        name: "join-list",
        runs: [run as string],
        profile: ada,
      });
      expect(built.skipped).toEqual([]);
      const w = built.spec;
      expect(w.start).toBe(url);
      const fills = w.screens.flatMap((s) =>
        s.ops.flatMap((op) => (op.kind === "fill" ? [[op.goal, op.value]] : [])),
      );
      expect(fills).toEqual([
        ["fill Name", { from: "profile", field: "name" }],
        ["fill Email", { from: "profile", field: "email" }],
        ["fill Note", { from: "plan", field: "note" }],
      ]);
      expect(w.fields).toMatchObject([{ key: "note", default: "first" }]);
      const size = built.guesses.find((x) => x.label === "Size") as Guess;
      expect(size.options).toEqual(["1-10", "11-50"]);
      expect(choose(w, size, { to: "ask" }).fields.at(-1)).toMatchObject({
        label: "Size",
        options: ["1-10", "11-50"],
      });
      expect(w.screens.find((s) => s.goal)?.landmarks).toContain("heading you are on the list");

      const out = await flowRunner(browser(dir), { pace: null }).run(
        walkFlow(w, { profile: async (f) => profileField(grace, f) }),
        { note: "second" },
      );
      expect(out.screens.length).toBe(2);
      expect(joined.at(-1)).toEqual({
        name: "Grace Hopper",
        email: "grace@site.test",
        note: "second",
        size: "11-50",
        plan: "free",
      });
    } finally {
      server.close();
      await sleep(300);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 90_000);
});
