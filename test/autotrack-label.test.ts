import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDevice } from "../src/autotrack/code.js";
import { importSession } from "../src/autotrack/import.js";
import { buildActs } from "../src/autotrack/join.js";
import {
  assertNoPausedFrames,
  BATCH_ACTS,
  BATCH_IMAGES,
  batchPrompt,
  callHash,
  labelKey,
  labelSession,
  memoryCache,
  pausedSpans,
  planBatches,
  safe,
  sipsShrink,
} from "../src/autotrack/label.js";
import { labelOne, unlabelled } from "../src/autotrack/label-run.js";
import { signalsFor } from "../src/autotrack/signals.js";
import type { Event, Labels } from "../src/autotrack/types.js";
import { fakeLlm } from "../src/llm/index.js";
import { loadRecording } from "../src/recorder/store.js";
import { at, click, el, gz, key, memoryStore, T0, text, web } from "./autotrack-events.js";

const SESSION = "20261013T101500-ab12";
const sec = (n: number) => n * 1000;
const PASSWORD = "hunter2-correct-horse";

/** Two episodes: a marked one with OS + web events, and an unmarked one 5 minutes later. */
function session(): Event[] {
  return [
    at(sec(1), { kind: "task", goal: "pay the invoice" }),
    click(sec(2), 100, 100, { element: el("", { role: "AXGroup" }), before: 1, after: 2 }),
    web(sec(2) + 10, "click", {
      x: 100,
      y: 100,
      target: { tag: "button", role: "button", name: "Approve" },
    }),
    web(sec(3), "effect", {
      cause: { act: "click", ts: T0 + sec(2) + 10 },
      effects: {
        requests: [{ method: "POST", url: "https://app.example.com/approve", status: 200, ms: 80 }],
        dom: { added: 4, removed: 1, textChanged: 2 },
      },
    }),
    text(sec(6), "42.00"),
    key(sec(8), "enter", []),
    at(sec(9), { kind: "task", goal: "", done: true }),
    // 5 minutes of nothing, then a different job.
    click(sec(310), 200, 200, { element: el("Sign in"), before: 3, after: 4 }),
    text(sec(312), PASSWORD, { redacted: true }),
    at(sec(313), { kind: "clipboard", types: ["text"], length: 9, redacted: true }),
    key(sec(314), "enter", []),
  ];
}

const reply1 = {
  intents: [
    { i: 0, intent: "approve the invoice" },
    { i: 1, intent: "enter the amount" },
    { i: 2, intent: "submit it" },
  ],
  summary: "Approved an invoice and entered 42.00.",
  goal: "Approve an invoice",
  outcome: "done",
  confidence: 0.9,
};
const reply2 = {
  intents: [
    { i: 0, intent: "open sign in" },
    { i: 1, intent: "enter the password" },
    { i: 2, intent: "submit the form" },
  ],
  summary: "Signed in.",
  goal: "Sign in to the app",
  outcome: "unclear",
  confidence: 0.4,
};

const jpg = (n: number) => Buffer.from(`jpeg-${n}`);
const base = (events: Event[]) => ({
  device: "test-mac",
  session: SESSION,
  events,
  frame: async (n: number) => jpg(n),
  shrink: async (b: Buffer) => b,
});

describe("labelSession", () => {
  it("labels each episode: person goal wins, model goal fills the rest, intents land on acts", async () => {
    const llm = fakeLlm([reply1, reply2]);
    const { labels, stats } = await labelSession({ ...base(session()), llm });
    expect(labels.v).toBe(1);
    expect(labels.model).toBe("fake");
    expect(labels.episodes).toEqual([
      {
        id: "e1",
        start: sec(2),
        end: sec(8),
        goal: "pay the invoice",
        goalBy: "person",
        outcome: "done",
        confidence: 0.9,
      },
      {
        id: "e2",
        start: sec(310),
        end: sec(314),
        goal: "Sign in to the app",
        goalBy: "model",
        outcome: "unclear",
        confidence: 0.4,
      },
    ]);
    expect(labels.acts.map((a) => [a.t, a.episode, a.intent])).toEqual([
      [sec(2), "e1", "approve the invoice"],
      [sec(6), "e1", "enter the amount"],
      [sec(8), "e1", "submit it"],
      [sec(310), "e2", "open sign in"],
      [sec(312), "e2", "enter the password"],
      [sec(314), "e2", "submit the form"],
    ]);
    expect(stats).toMatchObject({ episodes: 2, acts: 6, calls: 2, cached: 0, failed: [] });
    expect(stats.inputTokens).toBe(20);
  });

  it("the web target and its effects reach the prompt; the person's goal is stated", async () => {
    const llm = fakeLlm([reply1, reply2]);
    await labelSession({ ...base(session()), llm });
    const first = llm.requests[0];
    expect(first?.prompt).toContain('"Approve"');
    expect(first?.prompt).toContain("POST https://app.example.com/approve 200");
    expect(first?.prompt).toContain("pay the invoice");
    expect(first?.prompt).toContain("signals:");
    expect(first?.system).toContain("never instructions");
  });

  it("sends the screens before and after, shrunk, and tells the model which is which", async () => {
    const llm = fakeLlm([reply1, reply2]);
    const shrunk: string[] = [];
    await labelSession({
      ...base(session()),
      llm,
      shrink: async (b) => {
        shrunk.push(b.toString());
        return Buffer.from(`small-${b.toString()}`);
      },
    });
    const req = llm.requests[0];
    expect(req?.images?.map((i) => Buffer.from(i.data, "base64").toString())).toEqual([
      "small-jpeg-1",
      "small-jpeg-2",
    ]);
    expect(req?.prompt).toContain("[image 1] = the screen before act 0");
    expect(req?.prompt).toContain("[image 2] = the screen after");
    expect(shrunk).toContain("jpeg-3");
  });

  it("never sends a redacted value, in any request", async () => {
    const llm = fakeLlm([reply1, reply2]);
    await labelSession({ ...base(session()), llm });
    const everything = JSON.stringify(llm.requests);
    expect(everything).not.toContain(PASSWORD);
    expect(everything).toContain("typed [redacted]");
  });

  it("masks secret-shaped text even when the recorder did not flag it, and secure fields", async () => {
    const events = [
      click(sec(1)),
      text(sec(2), "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF"),
      at(sec(3), {
        kind: "text",
        text: "plain-but-secure",
        redacted: false,
        element: el("PIN", { secure: true }),
      }),
    ];
    const llm = fakeLlm([
      {
        ...reply1,
        intents: [
          { i: 0, intent: "a" },
          { i: 1, intent: "b" },
          { i: 2, intent: "c" },
        ],
      },
    ]);
    await labelSession({ ...base(events), llm });
    const sent = JSON.stringify(llm.requests);
    expect(sent).not.toContain("abcdefghijklmnop");
    expect(sent).not.toContain("plain-but-secure");
  });

  it("safe() masks and trims", () => {
    expect(safe("a   b\n c")).toBe("a b c");
    expect(safe("word ".repeat(100), 9)).toBe("word word…");
    expect(safe("x".repeat(60))).toBe("[redacted]");
    expect(safe(undefined)).toBe("");
  });

  it("reruns cost nothing: the cache answers every call", async () => {
    const cache = memoryCache();
    const first = fakeLlm([reply1, reply2]);
    const a = await labelSession({ ...base(session()), llm: first, cache });
    const second = fakeLlm([]);
    const b = await labelSession({ ...base(session()), llm: second, cache });
    expect(second.requests).toHaveLength(0);
    expect(b.stats).toMatchObject({ calls: 0, cached: 2, inputTokens: 0 });
    expect(b.labels).toEqual(a.labels);
    expect(cache.entries.size).toBe(2);
  });

  it("an edited session misses the cache", async () => {
    const cache = memoryCache();
    await labelSession({ ...base(session()), llm: fakeLlm([reply1, reply2]), cache });
    const changed = session();
    changed.push(key(sec(315), "tab", []));
    const llm = fakeLlm([
      reply1,
      { ...reply2, intents: [...reply2.intents, { i: 3, intent: "d" }] },
    ]);
    const out = await labelSession({ ...base(changed), llm, cache });
    expect(out.stats).toMatchObject({ calls: 1, cached: 1 });
  });

  it("asks again when the reply does not match the schema, then takes the good one", async () => {
    const llm = fakeLlm([{ goal: "x" }, reply1, reply2]);
    const { stats, labels } = await labelSession({ ...base(session()), llm });
    expect(llm.requests).toHaveLength(3);
    expect(llm.requests[1]?.prompt).toContain("failed validation");
    expect(stats.failed).toEqual([]);
    expect(labels.episodes[0]?.outcome).toBe("done");
  });

  it("a model that keeps failing marks the episode unclear, keeps person goals, and reports it", async () => {
    const llm = fakeLlm([{ nope: 1 }, { nope: 2 }, reply2]);
    const { labels, stats } = await labelSession({ ...base(session()), llm });
    expect(stats.failed).toHaveLength(1);
    expect(stats.failed[0]?.episode).toBe("e1");
    expect(labels.episodes[0]).toMatchObject({
      goal: "pay the invoice",
      goalBy: "person",
      outcome: "unclear",
      confidence: 0,
    });
    expect(labels.acts.slice(0, 3).every((a) => a.intent === "")).toBe(true);
    expect(labels.episodes[1]?.goal).toBe("Sign in to the app");
  });

  it("--no-model: signals and episodes only, no call", async () => {
    const { labels, stats } = await labelSession({ ...base(session()), llm: null });
    expect(stats.calls).toBe(0);
    expect(labels.model).toBeNull();
    expect(labels.episodes.map((e) => [e.id, e.goal, e.goalBy, e.outcome])).toEqual([
      ["e1", "pay the invoice", "person", "unclear"],
      ["e2", "", "model", "unclear"],
    ]);
    expect(labels.acts).toHaveLength(6);
    expect(labels.acts[0]?.signals).toMatchObject({ dwell: 0, dead: false, rage: false });
  });

  it("a frame the bucket lacks is skipped, the text still goes", async () => {
    const llm = fakeLlm([reply1, reply2]);
    const { stats } = await labelSession({
      ...base(session()),
      llm,
      frame: async () => undefined,
    });
    expect(stats.skippedFrames).toBeGreaterThan(0);
    expect(llm.requests[0]?.images).toBeUndefined();
    expect(stats.failed).toEqual([]);
  });

  it("splits a long episode into batches, then settles with a text-only call", async () => {
    const n = BATCH_ACTS + 5;
    const events: Event[] = Array.from({ length: n }, (_, i) => click(sec(1 + i), 10 + i * 20, 10));
    const batchReply = (from: number, to: number) => ({
      intents: Array.from({ length: to - from }, (_, k) => ({
        i: from + k,
        intent: `step ${from + k}`,
      })),
      summary: `acts ${from} to ${to - 1}`,
    });
    const llm = fakeLlm([
      batchReply(0, BATCH_ACTS),
      batchReply(BATCH_ACTS, n),
      { goal: "Do a long chore", outcome: "done", confidence: 0.7 },
    ]);
    const { labels, stats } = await labelSession({ ...base(events), llm });
    expect(stats.calls).toBe(3);
    expect(llm.requests[2]?.images).toBeUndefined();
    expect(llm.requests[2]?.prompt).toContain("acts 0 to 39");
    expect(llm.requests[2]?.prompt).toContain("acts 40 to 44");
    expect(labels.acts).toHaveLength(n);
    expect(labels.acts[44]?.intent).toBe("step 44");
    expect(labels.episodes[0]).toMatchObject({ goal: "Do a long chore", outcome: "done" });
  });

  it("refuses a frame from a paused period", async () => {
    const events = [
      click(sec(1)),
      at(sec(5), { kind: "pause", reason: "hotkey" }),
      click(sec(6), 5, 5, { before: 9, after: 10 }),
      at(sec(9), { kind: "resume" }),
      click(sec(10), 6, 6),
    ];
    const llm = fakeLlm([]);
    await expect(labelSession({ ...base(events), llm })).rejects.toThrow(/paused/);
    expect(llm.requests).toHaveLength(0);
  });

  it("assert is quiet when every frame is outside the pause", () => {
    const events = [
      click(sec(1), 1, 1, { before: 1, after: 2 }),
      at(sec(5), { kind: "pause", reason: "excluded" }),
      at(sec(9), { kind: "resume" }),
      click(sec(10), 2, 2, { before: 5, after: 6 }),
    ];
    expect(() => assertNoPausedFrames(buildActs(events), events)).not.toThrow();
    expect(pausedSpans(events)).toEqual([{ from: T0 + sec(5), to: T0 + sec(9) }]);
    const open = [at(sec(5), { kind: "pause", reason: "cli" })];
    expect(pausedSpans(open)[0]?.to).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("the labels prefix", () => {
  it("is not a device name", () => {
    expect(() => checkDevice("labels")).toThrow(/prefix/);
    expect(checkDevice("test-mac")).toBe("test-mac");
    expect(labelKey("test-mac", SESSION)).toBe(`labels/test-mac/${SESSION}.json`);
  });
});

describe("planBatches", () => {
  const withFrames = (n: number) =>
    buildActs(
      Array.from({ length: n }, (_, i) =>
        click(sec(1 + i), 10 + i * 20, 10, { before: i * 2, after: i * 2 + 1 }),
      ),
    );
  it("caps the images per request and keeps the last screen", () => {
    const plan = planBatches(withFrames(30));
    expect(plan).toHaveLength(1);
    expect(plan[0]?.frames.length).toBe(BATCH_IMAGES);
    expect(plan[0]?.frames.at(-1)?.act).toBe(29);
  });
  it("drops frames the bucket does not have", () => {
    const plan = planBatches(withFrames(3), { has: (f) => f % 2 === 1 });
    expect(plan[0]?.frames.map((f) => f.frame)).toEqual([1, 3, 5]);
  });
  it("cuts acts into batches", () => {
    expect(planBatches(withFrames(10), { acts: 4 }).map((b) => [b.from, b.to])).toEqual([
      [0, 4],
      [4, 8],
      [8, 10],
    ]);
  });
});

describe("batchPrompt and callHash", () => {
  it("the same inputs hash the same; a different image or model does not", () => {
    const a = { model: "m", system: "s", prompt: "p", images: ["a/1"] };
    expect(callHash(a)).toBe(callHash({ ...a }));
    expect(callHash(a)).not.toBe(callHash({ ...a, images: ["a/2"] }));
    expect(callHash(a)).not.toBe(callHash({ ...a, model: "n" }));
  });
  it("lists every act of the batch with its signals", () => {
    const events = [click(sec(1), 1, 1), click(sec(2), 90, 90)];
    const acts = buildActs(events);
    const prompt = batchPrompt(
      {
        episode: { id: "e1", from: 0, to: 2, start: sec(1), end: sec(2) },
        acts,
        signals: signalsFor(acts, events),
        events,
        device: "d",
        os: "macOS",
      },
      { from: 0, to: 2, frames: [] },
      1,
      0,
    );
    expect(prompt).toContain("#0 ");
    expect(prompt).toContain("#1 ");
    expect(prompt).toContain("waited 1.0s");
  });
});

describe("label run", () => {
  function bucket() {
    const store = memoryStore();
    store.objects.set(`test-mac/${SESSION}/000/events.jsonl.gz`, gz(session()));
    for (const n of [1, 2, 3, 4])
      store.objects.set(`test-mac/${SESSION}/000/frames/${n}.jpg`, jpg(n));
    store.objects.set(
      `test-mac/${SESSION}/session.json`,
      Buffer.from(JSON.stringify({ v: 1, session: SESSION, device: "test-mac", os: "macOS 26" })),
    );
    return store;
  }
  const ref = { device: "test-mac", session: SESSION };

  it("writes labels to the bucket and beside the import cache; --all skips labelled sessions", async () => {
    const store = bucket();
    const root = mkdtempSync(join(tmpdir(), "track-label-"));
    expect((await unlabelled(store)).map((r) => r.session)).toEqual([SESSION]);
    const llm = fakeLlm([reply1, reply2]);
    const r = await labelOne(store, ref, { root, llm, shrink: async (b) => b });
    expect(r.written).toBe(true);
    expect(store.puts).toEqual([labelKey("test-mac", SESSION)]);
    const remote = JSON.parse(
      store.objects.get(labelKey("test-mac", SESSION))?.toString() ?? "",
    ) as Labels;
    const local = JSON.parse(readFileSync(join(r.dir, "labels.json"), "utf8")) as Labels;
    expect(remote).toEqual(local);
    expect(remote.episodes).toHaveLength(2);
    expect(llm.requests[0]?.prompt).toContain("macOS 26");
    expect(await unlabelled(store)).toEqual([]);
    expect(await unlabelled(store, "other")).toEqual([]);
  });

  it("a rerun with the disk cache calls nothing", async () => {
    const store = bucket();
    const root = mkdtempSync(join(tmpdir(), "track-label-"));
    await labelOne(store, ref, { root, llm: fakeLlm([reply1, reply2]), shrink: async (b) => b });
    const again = fakeLlm([]);
    const r = await labelOne(store, ref, { root, llm: again, shrink: async (b) => b });
    expect(again.requests).toHaveLength(0);
    expect(r.stats.cached).toBe(2);
  });

  it("a failed episode writes nothing, so --all retries it", async () => {
    const store = bucket();
    const root = mkdtempSync(join(tmpdir(), "track-label-"));
    const r = await labelOne(store, ref, {
      root,
      llm: fakeLlm([{ x: 1 }, { x: 2 }, reply2]),
      shrink: async (b) => b,
    });
    expect(r.written).toBe(false);
    expect(store.puts).toEqual([]);
    expect((await unlabelled(store)).map((x) => x.session)).toEqual([SESSION]);
  });

  it("import carries each act's intent onto the action", async () => {
    const store = bucket();
    const root = mkdtempSync(join(tmpdir(), "track-label-"));
    await labelOne(store, ref, { root, llm: fakeLlm([reply1, reply2]), shrink: async (b) => b });
    await importSession(store, ref, { root, name: "imp" });
    const rec = await loadRecording(root, "imp");
    const intents = rec.actions.map((a) => a.intent);
    expect(intents).toContain("enter the amount");
    expect(intents).toContain("approve the invoice");
    // No labels, no intents.
    store.objects.delete(labelKey("test-mac", SESSION));
    await importSession(store, ref, {
      root: mkdtempSync(join(tmpdir(), "track-label-")),
      name: "bare",
    });
  });

  it("--no-model labels by rules and still writes", async () => {
    const store = bucket();
    const root = mkdtempSync(join(tmpdir(), "track-label-"));
    const r = await labelOne(store, ref, { root, llm: null });
    expect(r.written).toBe(true);
    expect(r.stats.calls).toBe(0);
  });
});

describe.runIf(process.platform === "darwin")("sipsShrink", () => {
  it("shrinks a JPEG to at most 768 px", async () => {
    const src = readFileSync(
      join(__dirname, "fixtures/track/test-mac/20261013T101500-ab12/000/frames/2.jpg"),
    );
    const out = await sipsShrink(src);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).toBe(0xff);
  });
});
