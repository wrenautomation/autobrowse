import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildActs } from "../src/autotrack/join.js";
import { pool } from "../src/autotrack/pool.js";
import { contextOf, levelAt, levelPoints, levelTime, qualityOf } from "../src/autotrack/quality.js";
import {
  buildSteps,
  displayOf,
  frameScale,
  type Step,
  type StepsInput,
  toFrame,
} from "../src/autotrack/steps.js";
import {
  qualityKey,
  qualityLine,
  readQualities,
  stepsKey,
  stepsOne,
} from "../src/autotrack/steps-run.js";
import { listSessions } from "../src/autotrack/store.js";
import { diffTrees, parseTree, type TreeNode } from "../src/autotrack/tree.js";
import type { Event, Labels, SessionMeta } from "../src/autotrack/types.js";
import { at, click, el, key, memoryStore, text } from "./autotrack-events.js";
import { fixtureStore, NEW, OLD } from "./autotrack-fixture.js";

const lines = (gz: Buffer): Step[] =>
  gunzipSync(gz)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Step);

describe("pool", () => {
  it("runs at most `size` at once and keeps the order", async () => {
    let live = 0;
    let peak = 0;
    const out = await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
    expect(await pool([], 4, async (n) => n)).toEqual([]);
  });

  it("rejects with the first failure", async () => {
    await expect(
      pool([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});

describe("trees", () => {
  it("reads the recorder's node list, a nested tree and a page outline", () => {
    const flat = JSON.stringify({
      nodes: [
        { role: "AXButton", name: "Save", id: "save", x: 1, y: 2, width: 3, height: 4, depth: 1 },
        { role: "AXGroup", name: "  ", x: 0, y: 0, width: 9, height: 9, depth: 1 },
      ],
      truncated: false,
      ms: 4,
    });
    expect(parseTree(flat, "json")).toEqual([
      { role: "AXButton", name: "Save", id: "save", x: 1, y: 2, width: 3, height: 4 },
    ]);
    const nested = JSON.stringify({
      role: "AXWindow",
      name: "Notes",
      children: [{ role: "AXButton", name: "New Note", children: [{ role: "AXImage", name: "" }] }],
    });
    expect(parseTree(nested, "json").map((n) => n.name)).toEqual(["Notes", "New Note"]);
    const outline = [
      '- heading "Notes" [level=1]',
      '  - link "Docs \\"v2\\"":',
      "    - /url: /docs",
      "  - text: loose words",
      'button "Save"',
    ].join("\n");
    expect(parseTree(outline, "txt")).toEqual([
      { role: "heading", name: "Notes" },
      { role: "link", name: 'Docs "v2"' },
      { role: "button", name: "Save" },
    ]);
    expect(parseTree("{nope", "json")).toEqual([]);
    expect(parseTree("null", "json")).toEqual([]);
  });

  const n = (role: string, name: string, o: Partial<TreeNode> = {}): TreeNode => ({
    role,
    name,
    ...o,
  });

  it("diffs by role and name, counting repeats", () => {
    const before = [n("button", "OK"), n("button", "OK"), n("link", "Docs"), n("text", "Old")];
    const after = [n("button", "OK"), n("link", "Docs"), n("text", "New"), n("heading", "Hi")];
    const d = diffTrees(before, after);
    expect(d.removed).toEqual([
      { role: "button", name: "OK" },
      { role: "text", name: "Old" },
    ]);
    expect(d.added).toEqual([
      { role: "text", name: "New" },
      { role: "heading", name: "Hi" },
    ]);
    // Web outlines have no ids or rectangles: a changed name is an add and a remove.
    expect(d.renamed).toEqual([]);
    expect(d.counts).toEqual({ added: 2, removed: 2, renamed: 0 });
    expect(diffTrees(before, before)).toEqual({
      added: [],
      removed: [],
      renamed: [],
      counts: { added: 0, removed: 0, renamed: 0 },
    });
  });

  it("calls a same-role node at the same id or rectangle with a new name a rename", () => {
    const rect = { x: 10, y: 10, width: 50, height: 20 };
    const before = [
      n("AXButton", "New Note", { id: "new" }),
      n("AXStaticText", "Draft", rect),
      n("AXLink", "Gone", { x: 0, y: 0, width: 5, height: 5 }),
    ];
    const after = [
      n("AXButton", "Save", { id: "new" }),
      n("AXStaticText", "Final", rect),
      n("AXLink", "Elsewhere", { x: 99, y: 99, width: 5, height: 5 }),
    ];
    const d = diffTrees(before, after);
    expect(d.renamed).toEqual([
      { role: "AXButton", from: "New Note", to: "Save" },
      { role: "AXStaticText", from: "Draft", to: "Final" },
    ]);
    expect(d.removed).toEqual([{ role: "AXLink", name: "Gone" }]);
    expect(d.added).toEqual([{ role: "AXLink", name: "Elsewhere" }]);
    expect(d.counts).toEqual({ added: 1, removed: 1, renamed: 2 });
  });

  it("lists at most 40 of each and keeps the full count", () => {
    const many = Array.from({ length: 100 }, (_, i) => n("text", `row ${i}`));
    const d = diffTrees([], many);
    expect(d.added).toHaveLength(40);
    expect(d.counts.added).toBe(100);
  });
});

describe("frame coordinates", () => {
  const meta = {
    displays: [
      { id: "1", x: 0, y: 0, width: 1440, height: 900, scale: 2, primary: true },
      { id: "2", x: 1440, y: 0, width: 1920, height: 1080, scale: 1, primary: false },
      { id: "3", x: 0, y: -2160, width: 3840, height: 2160, scale: 2, primary: false },
    ],
  } as SessionMeta;
  const [d1, d2, d3] = meta.displays as [
    SessionMeta["displays"][number],
    SessionMeta["displays"][number],
    SessionMeta["displays"][number],
  ];

  it("scales by the display, unless the 1920 px cap shrank the frame", () => {
    expect(frameScale(d1)).toBeCloseTo(1920 / 1440, 6); // 2880 px native, capped
    expect(frameScale(d2)).toBe(1); // already 1920
    expect(frameScale(d3)).toBe(0.5); // 4K at 2x: 7680 px native, capped to 1920
    expect(frameScale({ ...d1, width: 1000, height: 600, scale: 1.5 })).toBe(1.5); // under the cap
  });

  it("measures from the display's own origin", () => {
    expect(toFrame(d1, 720, 450)).toEqual({ x: 960, y: 600, nx: 0.5, ny: 0.5 });
    expect(toFrame(d2, 2400, 540)).toEqual({ x: 960, y: 540, nx: 0.5, ny: 0.5 });
    expect(toFrame(d3, 1920, -1080)).toEqual({ x: 960, y: 540, nx: 0.5, ny: 0.5 });
    // A point past the edge is held to it.
    expect(toFrame(d1, 5000, -5)).toEqual({ x: 1920, y: 0, nx: 1, ny: 0 });
  });

  it("picks the named display, else the one holding the point, else the primary", () => {
    expect(displayOf(meta, "2", 10, 10)?.id).toBe("2");
    expect(displayOf(meta, undefined, 2000, 100)?.id).toBe("2");
    expect(displayOf(meta, undefined, 100, -100)?.id).toBe("3");
    expect(displayOf(meta, "9", 99_999, 99_999)?.id).toBe("1");
    expect(displayOf(null, undefined, 0, 0)).toBeUndefined();
  });
});

describe("level and quality maths", () => {
  const evs: Event[] = [
    at(0, { kind: "level", level: "full", why: "ac" }),
    at(1000, { kind: "level", level: "lean", why: "battery" }),
    at(3000, { kind: "level", level: "normal", why: "ac" }),
  ];

  it("finds the level in force and the time at each", () => {
    const pts = levelPoints([...evs].reverse());
    expect(pts.map((p) => p.level)).toEqual(["full", "lean", "normal"]);
    const t0 = evs[0]?.ts ?? 0;
    expect(levelAt(pts, t0 - 1)).toBeUndefined();
    expect(levelAt(pts, t0 + 999)).toBe("full");
    expect(levelAt(pts, t0 + 1000)).toBe("lean");
    expect(levelTime(pts, t0, t0 + 5000)).toEqual({ full: 1000, lean: 2000, normal: 2000 });
    expect(levelTime(pts, t0 + 500, t0 + 1500)).toEqual({ full: 500, lean: 500 });
    expect(levelTime([], t0, t0 + 1)).toEqual({});
  });

  it("sums helper restarts over segments, and has none to report without stats", () => {
    const seg = (restarts: Record<string, number>) => ({ restarts }) as never;
    expect(contextOf([], []).helperRestarts).toBeUndefined();
    expect(contextOf([], [seg({ probe: 1, ocr: 2 }), seg({})]).helperRestarts).toBe(3);
    // An older or hand-made stats file without the field counts as none, not NaN.
    expect(contextOf([], [{} as never]).helperRestarts).toBe(0);
  });

  it("scores the mean of the shares that apply, and nothing for web-only runs", () => {
    const ctx = { levels: [], pauses: [] };
    const row = (o: Partial<Parameters<typeof qualityOf>[0][number]>) => ({
      os: true,
      pointer: true,
      frames: true,
      element: true,
      tree: true,
      crop: true,
      ...o,
    });
    const q = qualityOf(
      [row({}), row({ frames: false, crop: false }), row({ pointer: false, crop: false })],
      { from: 0, to: 1 },
      ctx,
    );
    expect(q).toMatchObject({ acts: 3, frames: 0.667, element: 1, tree: 1, crop: 0.5 });
    expect(q.score).toBeCloseTo((0.667 + 1 + 1 + 0.5) / 4, 3);
    // Browser-only acts carry no frames: they are not counted against the session.
    const web = qualityOf([row({ os: false, frames: false })], { from: 0, to: 1 }, ctx);
    expect(web).toMatchObject({ acts: 0, frames: null, crop: null, score: 0 });
  });
});

const sec = (n: number) => n * 1000;

describe("steps of a session recorded with the quality fields", () => {
  async function run(o: { minQuality?: number; labels?: Labels } = {}) {
    const store = fixtureStore();
    if (o.labels)
      await store.put(
        `labels/${NEW.device}/${NEW.session}.json`,
        Buffer.from(JSON.stringify(o.labels)),
      );
    store.puts.length = 0;
    const root = mkdtempSync(join(tmpdir(), "track-steps-"));
    const out = await stepsOne(store, NEW, { root, ...o });
    const steps = lines(store.objects.get(stepsKey(NEW.device, NEW.session)) as Buffer);
    return { store, root, out, steps };
  }

  it("makes one step per act, with the screen before and after", async () => {
    const { steps } = await run();
    expect(steps.map((s) => [s.episode, s.step, s.action.type])).toEqual([
      ["e1", 0, "click"],
      ["e1", 1, "text"],
      ["e1", 2, "key"],
      ["e2", 0, "click"],
      ["e2", 1, "scroll"],
      ["e2", 2, "key"],
    ]);
    const [click0, text0, key0] = steps;
    expect(click0).toMatchObject({
      episode: "e1",
      goal: "write a note",
      t: 1000,
      obs: { frame: 3, crop: 1, tree: 5, ocr: 3 },
      // 1440x900 at 2x, frames capped at 1920: 1.333 px per point.
      action: { type: "click", x: 13, y: 27, nx: 0.0069, ny: 0.0222, button: "left", count: 1 },
      element: { role: "AXButton", name: "New Note" },
      next: { frame: 4, tree: 6 },
      settle: 240,
      settled: true,
      out: { screen: true },
      level: "full",
    });
    // The cursor's approach, in the same frame pixels as the click.
    expect(click0?.action.path).toEqual([
      [-900, 400, 400],
      [-500, 133, 133],
      [-100, 16, 29],
    ]);
    expect(click0?.signals).toMatchObject({ dwell: 0, dead: false, rage: false });
    // The tree before and the first one after: a rename, an add and a remove.
    expect(click0?.treeDiff).toEqual({
      added: [{ role: "AXTextArea", name: "Note body" }],
      removed: [{ role: "AXStaticText", name: "Untitled" }],
      renamed: [{ role: "AXButton", from: "New Note", to: "Save" }],
      counts: { added: 1, removed: 1, renamed: 1 },
    });
    // A text act: its OCR file is a `{same}` pointer, no crop, and no tree came after it.
    expect(text0).toMatchObject({
      obs: { frame: 4, tree: 6, ocr: 4 },
      action: { type: "text", text: "hello" },
      next: { frame: 7 },
      settled: true,
    });
    expect(text0?.obs).not.toHaveProperty("crop");
    expect(text0?.treeDiff).toBeUndefined();
    // Out of time before it held still: the after frame (8) never shipped, and it says so.
    expect(key0).toMatchObject({
      obs: { frame: 7, tree: 6 },
      action: { type: "key", key: "enter", mods: [] },
      next: {},
      settle: 3000,
      settled: false,
    });
  });

  it("puts the second display's click in that display's frame and carries the lean level", async () => {
    const { steps } = await run();
    const [, , , click1, scroll, key1] = steps;
    // Global (2400, 540) is (960, 540) on a 1920x1080 display at x=1440.
    expect(click1).toMatchObject({
      episode: "e2",
      step: 0,
      action: { type: "click", x: 960, y: 540, nx: 0.5, ny: 0.5 },
      obs: { frame: 9, tree: 6 },
      next: { frame: 10 },
      level: "lean",
    });
    expect(click1).not.toHaveProperty("goal");
    expect(click1).not.toHaveProperty("settled");
    // Lean has no settle: absent, not false.
    expect(click1?.settle).toBeUndefined();
    // Two scroll events within 1.5 s are one act: the distance adds up, the run ends on the last frame.
    expect(scroll).toMatchObject({
      action: { type: "scroll", dx: 0, dy: -5, x: 960 },
      obs: { frame: 10 },
    });
    expect(scroll?.next).toEqual({});
    expect(key1?.level).toBe("lean");
  });

  it("reports quality per episode and per session", async () => {
    const { out } = await run();
    const r = out.report;
    expect(r).toMatchObject({
      v: 1,
      device: "test-mac",
      session: NEW.session,
      minQuality: 0,
      steps: 6,
    });
    const [e1, e2] = r.episodes;
    // e1: frames 2/3 (the key never settled), element 2/3, tree 3/3, crop 1/1.
    expect(e1).toMatchObject({ id: "e1", goal: "write a note", steps: 3, kept: true, acts: 3 });
    expect(e1?.frames).toBeCloseTo(0.667, 3);
    expect(e1?.element).toBeCloseTo(0.667, 3);
    expect(e1?.tree).toBe(1);
    expect(e1?.crop).toBe(1);
    expect(e1?.score).toBeCloseTo((0.667 + 0.667 + 1 + 1) / 4, 3);
    expect(e1?.levelMs).toEqual({ full: 3200 - 1000 });
    expect(e1?.gaps).toEqual({ pauses: 0, pausedMs: 0 });
    // e2: lean, so no settle, no crop, no element: only the tree (the stale one) is there.
    expect(e2).toMatchObject({
      id: "e2",
      steps: 3,
      frames: 0,
      element: 0,
      tree: 1,
      crop: 0,
      score: 0.25,
    });
    expect(e2?.levelMs).toEqual({ lean: 13_000 });
    expect(e2?.gaps).toEqual({ pauses: 1, pausedMs: 10_000 });
    // The session: all six acts, the whole level timeline, and the helper restart from stats.
    expect(r.acts).toBe(6);
    expect(r.frames).toBeCloseTo(0.333, 3);
    expect(r.crop).toBeCloseTo(0.333, 3);
    expect(r.score).toBeCloseTo(0.5, 2);
    expect(r.levelMs).toEqual({ full: 299_000, lean: 14_000 });
    expect(r.gaps).toEqual({ pauses: 1, pausedMs: 10_000, helperRestarts: 1 });
  });

  it("writes the steps and then the quality report, to the bucket and beside the import", async () => {
    const { store, root, out, steps } = await run();
    expect(store.puts).toEqual([
      stepsKey(NEW.device, NEW.session),
      qualityKey(NEW.device, NEW.session),
    ]);
    expect(stepsKey("d", "s")).toBe("steps/d/s.jsonl.gz");
    expect(qualityKey("d", "s")).toBe("steps/d/s.quality.json");
    const report = JSON.parse(
      (store.objects.get(qualityKey(NEW.device, NEW.session)) as Buffer).toString("utf8"),
    );
    expect(report).toEqual(JSON.parse(JSON.stringify(out.report)));
    const track = join(root, `test-mac-${NEW.session.toLowerCase()}`, "track");
    expect(out.dir).toBe(track);
    expect(lines(readFileSync(join(track, "steps.jsonl.gz")))).toEqual(steps);
    expect(JSON.parse(readFileSync(join(track, "quality.json"), "utf8")).session).toBe(NEW.session);
    // The new keys are not sessions: listing still sees two.
    expect(await listSessions(store)).toHaveLength(2);
  });

  it("--min-quality leaves out low episodes from the steps and says so in the report", async () => {
    const { steps, out, store } = await run({ minQuality: 0.5 });
    expect(steps.map((s) => s.episode)).toEqual(["e1", "e1", "e1"]);
    expect(out.report.steps).toBe(3);
    expect(out.report.minQuality).toBe(0.5);
    expect(out.report.episodes.map((e) => [e.id, e.kept])).toEqual([
      ["e1", true],
      ["e2", false],
    ]);
    // The session score is still over everything that was recorded.
    expect(out.report.acts).toBe(6);
    expect(store.objects.has(qualityKey(NEW.device, NEW.session))).toBe(true);
    // A threshold above every episode writes an empty steps file, not none.
    const none = await run({ minQuality: 0.95 });
    expect(none.steps).toEqual([]);
    expect(none.out.report.episodes.every((e) => !e.kept)).toBe(true);
  });

  it("takes the intent, goal and outcome from the labels when they exist", async () => {
    const signals = { dwell: 0, dead: false, rage: false, correction: false, error: false };
    const labels: Labels = {
      v: 1,
      session: NEW.session,
      model: "fake",
      episodes: [
        {
          id: "e1",
          start: 1000,
          end: 3200,
          goal: "Write a note",
          goalBy: "person",
          outcome: "done",
          confidence: 0.9,
        },
        {
          id: "e2",
          start: 300_000,
          end: 313_000,
          goal: "Scroll the notes",
          goalBy: "model",
          outcome: "unclear",
          confidence: 0.4,
        },
      ],
      acts: [
        { t: 1000, episode: "e1", intent: "start a new note", signals },
        { t: 300_000, episode: "e2", intent: "focus the second screen", signals },
      ],
    };
    const { steps, out } = await run({ labels });
    expect(steps[0]).toMatchObject({ goal: "Write a note", intent: "start a new note" });
    expect(steps[1]?.intent).toBeUndefined();
    expect(steps[3]).toMatchObject({ goal: "Scroll the notes", intent: "focus the second screen" });
    expect(out.report.episodes.map((e) => e.outcome)).toEqual(["done", "unclear"]);
  });
});

describe("steps of a session from an older recorder", () => {
  it("still parses: no crop, level, settle or OCR, and no stats to read", async () => {
    const store = fixtureStore();
    const root = mkdtempSync(join(tmpdir(), "track-steps-"));
    const out = await stepsOne(store, OLD, { root });
    const steps = lines(store.objects.get(stepsKey(OLD.device, OLD.session)) as Buffer);
    expect(steps.length).toBe(out.steps);
    expect(steps.length).toBeGreaterThan(5);
    // Frame 1 never shipped; frame 2 did, and is the first click's after-frame.
    expect(steps[0]).toMatchObject({
      obs: {},
      action: { type: "click", x: 13, y: 27 },
      next: { frame: 2 },
    });
    for (const s of steps) {
      expect(s).not.toHaveProperty("level");
      expect(s).not.toHaveProperty("settled");
      expect(s.obs).not.toHaveProperty("crop");
      expect(s.obs).not.toHaveProperty("ocr");
    }
    // The password field's text is never copied.
    const pw = steps.find((s) => s.t === 4000);
    expect(pw?.action.text).toBe("<redacted>");
    // Nothing settled and nothing cropped: it scores low, honestly, and has no level timeline.
    expect(out.report.frames).toBe(0);
    expect(out.report.levelMs).toEqual({});
    expect(out.report.gaps).not.toHaveProperty("helperRestarts");
    expect(out.report.steps).toBe(steps.length);
  });

  it("does not choke on a tree it cannot read", async () => {
    const store = fixtureStore();
    const key = [...store.objects.keys()].find((k) => k.endsWith("trees/6.json.gz")) as string;
    store.objects.set(key, Buffer.from("not gzip"));
    const root = mkdtempSync(join(tmpdir(), "track-steps-"));
    await stepsOne(store, NEW, { root });
    const steps = lines(store.objects.get(stepsKey(NEW.device, NEW.session)) as Buffer);
    expect(steps[0]?.treeDiff).toBeUndefined();
    expect(steps[0]?.next.tree).toBe(6);
  });
});

describe("steps from events alone", () => {
  const input = (events: Event[], o: Partial<StepsInput> = {}): StepsInput => ({
    device: "d",
    session: "s",
    events,
    meta: null,
    labels: null,
    stats: [],
    has: { frame: () => true, crop: () => true, tree: () => true, ocr: () => false },
    tree: async () => undefined,
    ...o,
  });

  it("never copies typed secrets, whatever the flag says", async () => {
    const token = `sk-${"a".repeat(24)}`;
    const { steps } = await buildSteps(
      input([text(sec(1), token), text(sec(5), "", { redacted: true }), text(sec(9), "plain")]),
    );
    expect(steps.map((s) => s.action.text)).toEqual(["<redacted>", "<redacted>", "plain"]);
  });

  it("has no pixels without a session.json, and keeps everything else", async () => {
    const { steps } = await buildSteps(input([click(sec(1), 50, 60, { element: el("OK") })]));
    expect(steps[0]?.action).toEqual({ type: "click", button: "left", count: 1 });
    expect(steps[0]?.element?.name).toBe("OK");
  });

  it("takes the nearest tree at or before an act when the act names none", async () => {
    const { steps } = await buildSteps(
      input([
        at(sec(1), { kind: "tree", tree: 1 }),
        at(sec(2), { kind: "tree", tree: 2 }),
        click(sec(3)),
        at(sec(4), { kind: "tree", tree: 3 }),
        at(sec(20), { kind: "tree", tree: 4 }),
        key(sec(30), "a"),
      ]),
    );
    expect(steps[0]).toMatchObject({ obs: { tree: 2 }, next: { tree: 3 } });
    // The next act is 27 s on; the tree 16 s after the first act is nobody's consequence.
    expect(steps[1]).toMatchObject({ obs: { tree: 4 } });
    expect(steps[1]?.next.tree).toBeUndefined();
    const stale = await buildSteps(input([click(sec(1)), at(sec(8), { kind: "tree", tree: 9 })]));
    expect(stale.steps[0]?.next.tree).toBeUndefined();
  });

  it("does not point at files that never shipped", async () => {
    const { steps } = await buildSteps(
      input([click(sec(1), 1, 1, { before: 1, after: 2, crop: 3, tree: 4 })], {
        has: { frame: (n) => n === 2, crop: () => false, tree: () => false, ocr: () => false },
      }),
    );
    expect(steps[0]?.obs).toEqual({});
    expect(steps[0]?.next).toEqual({ frame: 2 });
  });

  it("is empty for a session with no acts", async () => {
    const { steps, report } = await buildSteps(input([at(0, { kind: "focus" })]));
    expect(steps).toEqual([]);
    expect(report).toMatchObject({ steps: 0, episodes: [], acts: 0, score: 0 });
    expect((await buildSteps(input([]))).report.score).toBe(0);
  });

  it("matches the acts the join builds, one step each", async () => {
    const events = [click(sec(1)), key(sec(2), "a"), text(sec(3), "x"), click(sec(70))];
    const { steps } = await buildSteps(input(events));
    expect(steps).toHaveLength(buildActs(events).length);
  });
});

describe("quality in the list", () => {
  it("reads each session's report and prints it on one line", async () => {
    const store = fixtureStore();
    const root = mkdtempSync(join(tmpdir(), "track-steps-"));
    const rows = await listSessions(store);
    expect((await readQualities(store, rows)).size).toBe(0);
    await stepsOne(store, NEW, { root });
    // A report that is not one is skipped, not fatal.
    await store.put(qualityKey(OLD.device, OLD.session), Buffer.from("{broken"));
    const got = await readQualities(store, rows);
    expect([...got.keys()]).toEqual([`${NEW.device}/${NEW.session}`]);
    const q = got.get(`${NEW.device}/${NEW.session}`);
    expect(q && qualityLine(q)).toBe("quality 0.50  full 96% lean 4%  restarts 1");
  });

  it("formats the level mix, long pauses and restarts", () => {
    const base = {
      v: 1,
      device: "d",
      session: "s",
      minQuality: 0,
      steps: 1,
      episodes: [],
    } as const;
    const q = (o: object) =>
      qualityLine({
        ...base,
        acts: 1,
        frames: 1,
        element: 1,
        tree: 1,
        crop: 1,
        score: 0.9,
        levelMs: {},
        gaps: { pauses: 0, pausedMs: 0 },
        ...o,
      });
    expect(q({})).toBe("quality 0.90");
    expect(q({ levelMs: { full: 3000, normal: 1000 } })).toBe("quality 0.90  full 75% normal 25%");
    expect(q({ gaps: { pauses: 2, pausedMs: 150_000, helperRestarts: 3 } })).toBe(
      "quality 0.90  paused 3m  restarts 3",
    );
  });
});

// The store the CLI writes to is a TrackWriter: a read-only one fails loudly, not silently.
describe("writing", () => {
  it("fails when the bucket cannot be written", async () => {
    const store = fixtureStore();
    store.put = async () => {
      throw new Error("AccessDenied");
    };
    const root = mkdtempSync(join(tmpdir(), "track-steps-"));
    await expect(stepsOne(store, NEW, { root })).rejects.toThrow("AccessDenied");
    expect(memoryStore().puts).toEqual([]);
  });
});
