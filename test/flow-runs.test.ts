import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defineFlow, flowRunner } from "../src/browser/flow.js";
import { statsDir } from "../src/deps/stats.js";
import { fakeLlm } from "../src/llm/fake.js";
import { makeLlm } from "../src/llm/index.js";
import {
  countedLlm,
  type LlmCall,
  llmCallReport,
  memoryLlmCalls,
  tallied,
} from "../src/llm/ledger.js";
import {
  type FlowRunRow,
  fileFlowRuns,
  flowRunReport,
  formatFlowRunReport,
  memoryFlowRuns,
  readFlowRuns,
} from "../src/runs/flows.js";

const row = (o: Partial<FlowRunRow> = {}): FlowRunRow => ({
  site: "lever",
  flow: "apply",
  startedAt: "2026-10-20T10:00:00.000Z",
  endedAt: "2026-10-20T10:00:30.000Z",
  ms: 30_000,
  outcome: "ok",
  submitted: true,
  goal: "submit",
  error: null,
  acts: 12,
  captchaTries: 0,
  captchaSolved: null,
  llmCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  ...o,
});

describe("flow runs", () => {
  const server = createServer((_q, r) =>
    r.writeHead(200, { "content-type": "text/html" }).end("<title>t</title><button>Go</button>"),
  );
  const ready = new Promise<string>((ok) =>
    server.listen(0, "127.0.0.1", () =>
      ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`),
    ),
  );
  afterAll(() => server.close());

  it("records every run, ok or not, with its acts and the model tokens spent inside it", async () => {
    const url = await ready;
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-flow-runs-"));
    const runs = memoryFlowRuns();
    const llm = countedLlm(fakeLlm(["{}", "{}"]), memoryLlmCalls());
    const runner = flowRunner(
      {
        tier: "local",
        channel: "chromium",
        profilesDir: join(dir, "profiles"),
        artifactsDir: join(dir, "artifacts"),
        headless: true,
      },
      { pace: null, runs },
    );
    const flow = defineFlow<boolean, void>({
      site: "scratch",
      name: "go",
      async run(fp, fail) {
        await fp.open(url);
        await llm.complete({ system: "s", prompt: "p", purpose: "captcha" });
        await fp.act({ kind: "click" }, { role: "button", name: "Go" }, { goal: "press go" });
        if (fail) throw new Error("the form said no");
      },
    });
    await runner.run(flow, false);
    await expect(runner.run(flow, true)).rejects.toThrow();
    const [ok, failed] = runs.rows;
    expect(ok).toMatchObject({ outcome: "ok", acts: 1, llmCalls: 1, submitted: false });
    expect(ok?.inputTokens).toBeGreaterThan(0);
    expect(failed).toMatchObject({ outcome: "failed", goal: "press go" });
    expect(failed?.error).toMatch(/the form said no/);
  }, 60_000);

  it("reports failure rate, durations and why, by flow", () => {
    const rows = [
      row({ ms: 10_000 }),
      row({ ms: 20_000, captchaTries: 2, captchaSolved: true }),
      row({
        outcome: "human",
        goal: "solve the captcha",
        error: "captcha",
        captchaTries: 3,
        captchaSolved: false,
      }),
      row({ site: "ashby", outcome: "failed", goal: "fill email", error: "Timeout" }),
    ];
    const r = flowRunReport(rows);
    expect(r).toMatchObject({
      runs: 4,
      ok: 2,
      failureRate: 0.5,
      captcha: { runs: 2, solved: 1, tries: 5 },
    });
    expect(r.byFlow.map((g) => [g.flow, g.runs])).toEqual([
      ["lever/apply", 3],
      ["ashby/apply", 1],
    ]);
    expect(r.byFailure.map((f) => f.goal)).toEqual(["solve the captcha", "fill email"]);
    expect(formatFlowRunReport(r).join("\n")).toMatch(/4 runs, 2 failed \(50%\)/);
  });

  it("keeps rows in month files and reads back a window", () => {
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-flow-file-"));
    const f = fileFlowRuns(dir);
    f.record(row({ startedAt: "2026-09-30T23:00:00.000Z" }));
    f.record(row({ startedAt: "2026-10-02T00:00:00.000Z", error: "x".repeat(1000) }));
    const got = readFlowRuns(dir, "2026-10-01T00:00:00.000Z");
    expect(got).toHaveLength(1);
    expect(got[0]?.error).toHaveLength(300);
  });
});

describe("model calls", () => {
  it("a tally sees only the calls made inside it", async () => {
    const calls = memoryLlmCalls();
    const llm = countedLlm(fakeLlm(["a", "b"]), calls);
    await llm.complete({ system: "s", prompt: "outside" });
    const t = tallied(() => llm.complete({ system: "s", prompt: "inside" }));
    await t.done;
    expect(calls.rows).toHaveLength(2);
    expect(t.tally.calls).toBe(1);
  });

  it("reports calls and tokens by purpose, model and day", () => {
    const c = (at: string, purpose: string, ok = true): LlmCall => ({
      at,
      model: "m",
      purpose,
      inputTokens: 100,
      cachedTokens: 0,
      outputTokens: 10,
      ms: 1,
      ok,
      images: 0,
      promptChars: 1,
    });
    const r = llmCallReport([
      c("2026-10-19T01:00:00Z", "captcha"),
      c("2026-10-20T01:00:00Z", "captcha", false),
      c("2026-10-20T02:00:00Z", "repair"),
    ]);
    expect(r).toMatchObject({ n: 3, failed: 1, inputTokens: 300, outputTokens: 30 });
    expect(r.byPurpose[0]).toMatchObject({ purpose: "captcha", n: 2 });
    expect(r.byDay.map((d) => [d.day, d.n])).toEqual([
      ["2026-10-19", 1],
      ["2026-10-20", 2],
    ]);
  });

  it("makeLlm counts by default; null counts nothing; stats can be turned off", () => {
    const s = {
      provider: "claude-code" as const,
      model: undefined,
      anthropicApiKey: undefined,
      openaiApiKey: undefined,
      openaiBaseUrl: undefined,
      cohereApiKey: undefined,
    };
    const http = {} as Parameters<typeof makeLlm>[1];
    const calls = memoryLlmCalls();
    expect(makeLlm(s, http, { calls })).not.toBeNull();
    expect(makeLlm(s, http, { calls: null })?.id).toBeDefined();
    expect(statsDir({ AUTOBROWSE_STATS: "off" })).toBeNull();
    expect(statsDir({ AUTOBROWSE_STATS_DIR: "/x" })).toBe("/x");
  });
});
