import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withCall } from "../src/browser/attempt.js";
import { defineFlow, FlowFailed, FlowInterrupted, type FlowRunner } from "../src/browser/flow.js";
import { NeedsHuman } from "../src/browser/session.js";
import { runLeg } from "../src/engine/leg.js";
import {
  engineRunsView,
  fileEngineRuns,
  memoryEngineRuns,
  mergePages,
  stepRows,
} from "../src/runs/engine.js";

const flow = defineFlow<{ x: number }, { lead: string }>({
  site: "s",
  name: "f",
  run: async () => ({ lead: "x" }),
});

const throwing = (err: unknown): FlowRunner => ({
  run: async () => {
    throw err;
  },
});

describe("runLeg", () => {
  it("gives back the leg's own answer; the row keeps no answer", async () => {
    const runs = memoryEngineRuns();
    const seen: unknown[] = [];
    const sink = { put: () => undefined };
    const runner: FlowRunner = {
      run: async (_f, input, on) => {
        seen.push(input, on);
        return { lead: "Ada" } as never;
      },
    };
    const page = { isClosed: () => false } as never;
    const out = await withCall("inv-1 s/f", () =>
      runLeg(runner, flow, { x: 1, sink } as never, { on: { page }, runs }),
    );
    expect(out).toEqual({ lead: "Ada" });
    // the input as given, a function and all; the armed tab too
    expect((seen[0] as { sink: unknown }).sink).toBe(sink);
    expect(seen[1]).toEqual({ page });
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]).toMatchObject({
      workflow: "s-f",
      key: "inv-1 s/f",
      site: "s",
      status: "done",
      gate: null,
      steps: [{ name: "f", status: "done" }],
    });
    expect(JSON.stringify(runs.rows[0])).not.toContain("Ada");
  });

  it.each([
    [
      "NeedsHuman",
      Object.assign(new NeedsHuman("s: captcha"), { artifacts: { screenshot: "/a.png" } }),
      "waiting",
      "needs-human",
    ],
    [
      "FlowFailed",
      new FlowFailed("s/f", new Error("no row"), { trace: "/t.zip" }),
      "failed",
      "failed",
    ],
    [
      "FlowInterrupted",
      new FlowInterrupted("s/f", new Error("ECONNRESET"), {}),
      "failed",
      "failed",
    ],
    ["Error", new Error("plain"), "failed", "failed"],
  ])("rethrows %s as the same object, and records its step", async (_n, err, status, step) => {
    const runs = memoryEngineRuns();
    const got = await runLeg(throwing(err), flow, { x: 1 }, { runs }).catch((e: unknown) => e);
    expect(got).toBe(err);
    expect(runs.rows[0]?.status).toBe(status);
    expect(runs.rows[0]?.steps[0]).toMatchObject({ name: "f", status: step });
    expect(runs.rows[0]?.steps[0]?.detail).toContain((err as Error).message);
    const a = (err as { artifacts?: { screenshot?: string; trace?: string } }).artifacts ?? {};
    if (a.screenshot) expect(runs.rows[0]?.steps[0]?.screenshot).toBe(a.screenshot);
    if (a.trace) expect(runs.rows[0]?.steps[0]?.trace).toBe(a.trace);
  });

  it("an answer JSON cannot hold still comes back", async () => {
    const odd = { n: 1n };
    const out = await runLeg({ run: async () => odd as never }, flow, { x: 1 }, { runs: null });
    expect(out).toBe(odd);
  });

  it("the Runs page reads the ledger: listed beside the registry, status with no actions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-runs-"));
    const runs = fileEngineRuns(dir);
    const err = Object.assign(new NeedsHuman("s: captcha"), {
      artifacts: { screenshot: "/a.png" },
    });
    await withCall("inv-2 s/f", () =>
      runLeg(throwing(err), flow, { x: 1 }, { runs }).catch(() => null),
    );
    const view = engineRunsView(dir);
    const [row] = view.list({});
    expect(row).toMatchObject({
      workflow: "s-f",
      key: "inv-2 s/f",
      status: "waiting",
      gate: "human",
    });
    expect(view.list({ status: ["done"] })).toEqual([]);
    expect(view.status("s-f", "inv-2 s/f")).toMatchObject({
      gate: { name: "human", step: "f", screenshot: "/a.png" },
      outcome: { status: "waiting", results: { f: { status: "needs-human" } } },
    });
    expect(view.status("s-f", "nope")).toBeNull();
    const old = {
      ...(row as NonNullable<typeof row>),
      key: "old",
      updatedAt: "2020-01-01T00:00:00.000Z",
    };
    expect(mergePages([old], view.list({}), 1)).toEqual([row]);
  });

  it("a retried call lists once, as its last try; a gate with no result shows its step", () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-runs-"));
    const runs = fileEngineRuns(dir);
    const at = new Date().toISOString();
    const row = {
      workflow: "s-f",
      key: "k",
      site: "s",
      startedAt: at,
      endedAt: at,
      ms: 1,
      gate: null,
      steps: [],
    };
    runs.record({ ...row, status: "failed" });
    runs.record({ ...row, status: "done" });
    expect(
      engineRunsView(dir)
        .list({})
        .map((r) => r.status),
    ).toEqual(["done"]);
    // a line half written waits for its end; then the tail alone is read
    const view = engineRunsView(dir);
    expect(view.list({})).toHaveLength(1);
    const file = join(dir, `engine-${at.slice(0, 7)}.jsonl`);
    const next = JSON.stringify({ ...row, key: "k2", status: "done" });
    appendFileSync(file, next.slice(0, 20));
    expect(view.list({})).toHaveLength(1);
    appendFileSync(file, `${next.slice(20)}\n`);
    expect(view.list({}).map((r) => r.key)).toEqual(["k2", "k"]);
    const gate = { name: "human" as const, step: "pay", prompt: "card?", openedAt: at };
    expect(stepRows({}, gate)).toEqual([{ name: "pay", status: "waiting", at, detail: "card?" }]);
  });
});
