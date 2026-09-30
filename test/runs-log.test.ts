import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyChain } from "credvault";
import { describe, expect, it } from "vitest";
import type { Action } from "../src/recorder/types.js";
import {
  baseSite,
  INDEX,
  listRuns,
  newRunId,
  openRuns,
  type RunSummary,
  readRun,
  runFile,
  runLog,
  tokensOf,
} from "../src/runs/log.js";

const tmp = () => mkdtempSync(join(tmpdir(), "autobrowse-runs-log-"));

/** A clock that moves one second a call, from a fixed start. */
const clock = (start = "2026-09-30T12:00:00.000Z") => {
  let t = Date.parse(start);
  return () => {
    const d = new Date(t);
    t += 1000;
    return d;
  };
};

const startBody = (goal: string | null, driver = "console") => ({
  run: "",
  site: "scratch",
  driver,
  goal,
  machine: "test-box",
  resumed: false,
  viewport: { width: 1280, height: 800 },
});

const click: Action = {
  kind: "click",
  t: 0,
  url: "https://site.test/signup",
  target: {
    tag: "button",
    role: "button",
    name: "Continue",
    text: null,
    placeholder: null,
    id: null,
    testId: null,
    href: null,
    inputType: null,
  },
};
const look = { url: "site.test/signup", landmarks: ["heading sign up", "button continue"] };

const cmd = (chars: number, full: number | null, name = "click") => ({
  cmd: name,
  ok: true,
  error: null,
  ms: 12,
  chars,
  full,
  host: "site.test",
});

describe("newRunId", () => {
  it("is the UTC day and time, then four hex", () => {
    const id = newRunId(new Date("2026-09-30T23:15:07.123Z"));
    expect(id).toMatch(/^20260930-231507-[0-9a-f]{4}$/);
  });

  it("differs for two runs in the same second", () => {
    const d = new Date("2026-09-30T23:15:07.000Z");
    const ids = new Set(Array.from({ length: 20 }, () => newRunId(d)));
    expect(ids.size).toBeGreaterThan(1);
  });
});

describe("runFile", () => {
  it("files a run under its base site", () => {
    expect(runFile("/r", "google@ops", "20260930-120000-abcd")).toBe(
      join("/r", "google", "20260930-120000-abcd.jsonl"),
    );
    expect(baseSite("google@ops")).toBe("google");
    expect(baseSite("google")).toBe("google");
  });

  it("refuses a site that cannot name a folder", () => {
    for (const s of ["../x", "a/b", "@ops", "", ".hidden", "x y"])
      expect(() => runFile("/r", s, "20260930-120000-abcd"), s).toThrow(
        /cannot name a runs folder/,
      );
  });

  it("refuses an id that is not a run id", () => {
    for (const id of [
      "2026-09-30",
      "../../etc/passwd",
      "20260930-120000-ABCD",
      "20260930-120000-abc",
      "",
    ])
      expect(() => runFile("/r", "scratch", id), id).toThrow(/is not a run id/);
  });
});

describe("runLog", () => {
  it("writes start, goal, cmd, act and end as chained rows credvault verifies", async () => {
    const dir = tmp();
    const log = runLog(dir, "scratch", { now: clock() });
    expect(log.id).toMatch(/^20260930-120000-[0-9a-f]{4}$/);
    expect(log.file).toBe(join(dir, "scratch", `${log.id}.jsonl`));
    log.start(startBody("join the list"));
    log.goal("join the list, then confirm");
    log.cmd(cmd(400, 4000));
    log.act(click, look);
    log.act(click, null, true);
    log.end({ outcome: "achieved", summary: "joined", look });
    const rows = readRun(log.file);
    expect(rows.map((r) => r.kind)).toEqual(["start", "goal", "cmd", "act", "act", "end"]);
    const raw = readFileSync(log.file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(raw[0].prev).toBe("");
    for (let i = 1; i < raw.length; i++) expect(raw[i].prev).toBe(raw[i - 1].hash);
    const v = await verifyChain(log.file);
    expect(v).toMatchObject({ ok: true, rows: 6, unchained: 0, brokenAt: null });
  });

  it("stamps at from the clock, numbers commands and estimates tokens", () => {
    const dir = tmp();
    const log = runLog(dir, "scratch", { now: clock() });
    log.start(startBody(null));
    log.cmd(cmd(401, null, "look"));
    log.cmd(cmd(8, 400));
    const cmds = readRun(log.file).filter((r) => r.kind === "cmd");
    expect(cmds.map((c) => (c.kind === "cmd" ? [c.n, c.tokens, c.cmd] : null))).toEqual([
      [1, 101, "look"],
      [2, 2, "click"],
    ]);
    expect(readRun(log.file)[0]?.at).toBe("2026-09-30T12:00:01.000Z");
    expect(tokensOf(0)).toBe(0);
    expect(tokensOf(1)).toBe(1);
    expect(tokensOf(4)).toBe(1);
    expect(tokensOf(5)).toBe(2);
  });

  it("marks a person's act as by hand, and only then", () => {
    const dir = tmp();
    const log = runLog(dir, "scratch", { now: clock() });
    log.act(click, look);
    log.act(click, null, true);
    const acts = readRun(log.file).filter((r) => r.kind === "act");
    expect(acts[0]).not.toHaveProperty("hand");
    expect(acts[0]).toMatchObject({ look });
    expect(acts[1]).toMatchObject({ hand: true, look: null });
  });

  it("ends once: a second end and any row after it are ignored", () => {
    const dir = tmp();
    const log = runLog(dir, "scratch", { now: clock() });
    log.start(startBody("g"));
    expect(log.ended()).toBe(false);
    log.end({ outcome: "achieved", summary: null, look: null });
    expect(log.ended()).toBe(true);
    log.end({ outcome: "closed", summary: null, look: null });
    log.cmd(cmd(10, null));
    log.act(click, look);
    log.goal("another");
    expect(readRun(log.file).map((r) => r.kind)).toEqual(["start", "end"]);
    const index = readFileSync(join(dir, INDEX), "utf8").trim().split("\n");
    expect(index).toHaveLength(1);
    expect(JSON.parse(index[0] as string).outcome).toBe("achieved");
  });

  it("writes an index summary with counts, tokens and what whole pages would cost", () => {
    const dir = tmp();
    const log = runLog(dir, "scratch@ops", { now: clock() });
    log.start(startBody("first goal", "agent:claude"));
    log.goal("second goal");
    log.cmd(cmd(400, 4000)); // 100 tokens, 1000 full
    log.cmd(cmd(41, null)); // 11 tokens, full = tokens
    log.act(click, look);
    log.end({ outcome: "saved", summary: "saved the flow", look });
    const [s] = listRuns(dir);
    expect(s).toEqual({
      run: log.id,
      site: "scratch@ops",
      driver: "agent:claude",
      goal: "second goal",
      outcome: "saved",
      summary: "saved the flow",
      startedAt: "2026-09-30T12:00:01.000Z",
      endedAt: "2026-09-30T12:00:06.000Z",
      cmds: 2,
      acts: 1,
      tokens: 111,
      full: 1011,
    } satisfies RunSummary);
    // The folder is the base site.
    expect(log.file).toBe(join(dir, "scratch", `${log.id}.jsonl`));
  });

  it("an end with no start in this life still summarizes (driver console, started at the end)", () => {
    const dir = tmp();
    const log = runLog(dir, "scratch", { now: clock() });
    log.end({ outcome: "idle", summary: null, look: null });
    const [s] = listRuns(dir);
    expect(s).toMatchObject({ driver: "console", goal: null, cmds: 0, acts: 0 });
    expect(s?.startedAt).toBe(s?.endedAt);
  });

  it("keeps files owner-only", () => {
    const dir = tmp();
    const log = runLog(dir, "scratch", { now: clock() });
    log.start(startBody(null));
    log.end({ outcome: "closed", summary: null, look: null });
    expect(statSync(log.file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, INDEX)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "scratch")).mode & 0o777).toBe(0o700);
  });

  it("a later life by id goes on the same chain and keeps the goal an earlier one named", async () => {
    const dir = tmp();
    const first = runLog(dir, "scratch", { now: clock() });
    first.start(startBody("join the list"));
    first.cmd(cmd(40, null));
    first.end({ outcome: "idle", summary: null, look: null });

    const second = runLog(dir, "scratch", { id: first.id, now: clock("2026-09-30T13:00:00.000Z") });
    expect(second.file).toBe(first.file);
    second.start({ ...startBody(null), resumed: true });
    second.cmd(cmd(80, null));
    second.end({ outcome: "achieved", summary: null, look: null });

    const rows = readRun(first.file);
    expect(rows.map((r) => r.kind)).toEqual(["start", "cmd", "end", "start", "cmd", "end"]);
    expect(await verifyChain(first.file)).toMatchObject({ ok: true, rows: 6 });
    const runs = listRuns(dir);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      run: first.id,
      goal: "join the list",
      outcome: "achieved",
      cmds: 1,
      tokens: 20,
      startedAt: "2026-09-30T13:00:00.000Z",
    });
  });

  it("a later life's goal row wins over the earlier goal", () => {
    const dir = tmp();
    const first = runLog(dir, "scratch", { now: clock() });
    first.start(startBody("old goal"));
    first.goal("newer goal");
    first.end({ outcome: "idle", summary: null, look: null });
    const second = runLog(dir, "scratch", { id: first.id, now: clock() });
    second.end({ outcome: "achieved", summary: null, look: null });
    expect(listRuns(dir)[0]?.goal).toBe("newer goal");
  });

  it("a later life after a crash mid-line keeps its own first row", () => {
    const dir = tmp();
    const first = runLog(dir, "scratch", { now: clock() });
    first.start(startBody("join the list"));
    first.cmd(cmd(40, null));
    appendFileSync(first.file, '{"kind":"act","at":"2026-09-30T12:00:03.000Z","act":{"ki');
    const second = runLog(dir, "scratch", { id: first.id, now: clock("2026-09-30T13:00:00.000Z") });
    second.start({ ...startBody(null), resumed: true });
    second.cmd(cmd(80, null));
    const kinds = readRun(first.file).map((r) => r.kind);
    expect(kinds).toEqual(["start", "cmd", "start", "cmd"]);
  });
});

describe("readRun", () => {
  it("is empty for a missing file and skips a torn line", () => {
    const dir = tmp();
    expect(readRun(join(dir, "nope.jsonl"))).toEqual([]);
    const f = join(dir, "x.jsonl");
    writeFileSync(
      f,
      `${JSON.stringify({ kind: "goal", at: "a", goal: "g1" })}\n{"kind":"go\n\n${JSON.stringify({ kind: "goal", at: "b", goal: "g2" })}\n{"cut`,
    );
    expect(readRun(f).map((r) => (r.kind === "goal" ? r.goal : null))).toEqual(["g1", "g2"]);
  });
});

describe("listRuns", () => {
  const summary = (run: string, outcome: RunSummary["outcome"]): RunSummary => ({
    run,
    site: "scratch",
    driver: "console",
    goal: null,
    outcome,
    summary: null,
    startedAt: "2026-09-30T12:00:00.000Z",
    endedAt: "2026-09-30T12:00:00.000Z",
    cmds: 0,
    acts: 0,
    tokens: 0,
    full: 0,
  });

  it("is empty with no index", () => {
    expect(listRuns(tmp())).toEqual([]);
  });

  it("keeps a run's last line, newest last, and skips torn lines", () => {
    const dir = tmp();
    const a = "20260930-120000-aaaa";
    const b = "20260930-120001-bbbb";
    writeFileSync(
      join(dir, INDEX),
      [
        JSON.stringify(summary(a, "idle")),
        JSON.stringify(summary(b, "achieved")),
        '{"run":"torn',
        JSON.stringify(summary(a, "achieved")),
        "",
      ].join("\n"),
    );
    const runs = listRuns(dir);
    expect(runs.map((r) => [r.run, r.outcome])).toEqual([
      [b, "achieved"],
      [a, "achieved"],
    ]);
  });
});

describe("openRuns", () => {
  it("is empty for a missing folder", () => {
    expect(openRuns(join(tmp(), "nope"))).toEqual([]);
  });

  it("finds runs with no end by their files, and ignores other files", () => {
    const dir = tmp();
    const done = runLog(dir, "scratch", { now: clock() });
    done.start(startBody(null));
    done.end({ outcome: "achieved", summary: null, look: null });
    const open = runLog(dir, "google@ops", { now: clock() });
    open.start(startBody(null));
    writeFileSync(join(dir, "scratch", "notes.txt"), "x");
    writeFileSync(join(dir, "scratch", "not-a-run.jsonl"), "x");
    mkdirSync(join(dir, "empty"));
    expect(openRuns(dir)).toEqual([{ site: "google", run: open.id }]);
  });

  it("finds an ended run whose later life died, and drops it once that life ends", () => {
    const dir = tmp();
    const first = runLog(dir, "scratch", { now: clock() });
    first.start(startBody("join"));
    first.end({ outcome: "idle", summary: null, look: null });
    expect(openRuns(dir)).toEqual([]);
    const later = runLog(dir, "scratch", { id: first.id, now: clock("2026-09-30T13:00:00.000Z") });
    later.start({ ...startBody(null), resumed: true });
    expect(openRuns(dir)).toEqual([{ site: "scratch", run: first.id }]);
    later.end({ outcome: "achieved", summary: null, look: null });
    expect(openRuns(dir)).toEqual([]);
  });
});
