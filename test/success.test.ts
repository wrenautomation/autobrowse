import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LlmCall } from "../src/llm/ledger.js";
import { fileSiteCalls, readSiteCalls, type SiteCallRow, settledCalls } from "../src/runs/calls.js";
import { fromCaps, fromRestate, newRows } from "../src/runs/import.js";
import type { RunSummary } from "../src/runs/log.js";
import {
  callFailure,
  cmdFailure,
  formatSuccessReport,
  missCause,
  routeShape,
  STRUGGLE,
  successReport,
  targetOf,
} from "../src/runs/success.js";
import type { Cmd } from "../src/runs/tokens.js";

const SINCE = "2026-10-01T00:00:00.000Z";
const UNTIL = "2026-10-31T00:00:00.000Z";

const call = (o: Partial<SiteCallRow>): SiteCallRow => ({
  at: "2026-10-05T10:00:00.000Z",
  service: "desk",
  site: "reddit",
  route: "GET /r/sales/new",
  caller: "Loop/x/run",
  invocation: "inv_1",
  attempt: 1,
  ok: true,
  status: null,
  terminal: false,
  error: null,
  ms: 10,
  ...o,
});

const run = (o: Partial<RunSummary>): RunSummary =>
  ({
    run: "20261005-100000-aaaa",
    site: "trello",
    goal: "make a board",
    outcome: "achieved",
    startedAt: "2026-10-05T10:00:00.000Z",
    endedAt: "2026-10-05T10:30:00.000Z",
    ...o,
  }) as RunSummary;

const cmd = (o: Partial<Cmd>): Cmd =>
  ({
    kind: "cmd",
    at: "2026-10-05T10:05:00.000Z",
    site: "trello",
    n: 1,
    cmd: "click",
    ok: true,
    error: null,
    ms: 5,
    chars: 100,
    tokens: 25,
    full: null,
    host: "trello.com",
    ...o,
  }) as Cmd;

describe("site call ledger", () => {
  it("appends a month file and reads back from a date; a call settles on its last try", () => {
    const dir = mkdtempSync(join(tmpdir(), "autobrowse-calls-"));
    const ledger = fileSiteCalls(dir);
    ledger.record(call({ at: "2026-09-30T23:00:00.000Z", invocation: "old" }));
    ledger.record(call({ ok: false, error: "x".repeat(1000) }));
    ledger.record(call({ attempt: 2 }));
    const rows = readSiteCalls(dir, SINCE);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.error).toHaveLength(300);
    expect(settledCalls(rows)).toMatchObject([{ ok: true, attempts: 2 }]);
  });
});

describe("failure kinds", () => {
  it("names why an explore command failed", () => {
    expect(cmdFailure("locator.click: Timeout 10000ms exceeded.")).toBe("target-miss");
    expect(
      cmdFailure(
        'page.waitForEvent: Timeout 10000ms exceeded while waiting for event "filechooser"',
      ),
    ).toBe("wait-timeout");
    expect(cmdFailure("place: no secrets in this session; password needs --signup")).toBe(
      "sign-in",
    );
    expect(cmdFailure("payment step asked: start paying")).toBe("gate");
    expect(cmdFailure("racknerd: login page (unknown-site)")).toBe("unknown-site");
    expect(cmdFailure("something else")).toBe("other");
  });

  it("names whose problem a failed call is, by status", () => {
    expect(callFailure({ status: 400, terminal: true })).toBe("request");
    expect(callFailure({ status: 429, terminal: true })).toBe("cap");
    expect(callFailure({ status: 502, terminal: true })).toBe("platform");
    expect(callFailure({ status: null, terminal: false })).toBe("unexpected");
  });

  it("reads why a locator missed off Playwright's call log", () => {
    const log = (lines: string[]) =>
      ["locator.click: Timeout 10000ms exceeded.", "Call log:", ...lines].join("\n  - ");
    expect(missCause(log(["waiting for getByRole('button', { name: 'Go' })"]))).toBe("not-found");
    expect(
      missCause(
        log([
          "waiting for getByRole('button', { name: 'Go' })",
          "  locator resolved to <button>Go</button>",
          '  <div class="modal"></div> intercepts pointer events',
        ]),
      ),
    ).toBe("covered");
    expect(
      missCause(log(["  locator resolved to <button>Go</button>", "  element is not visible"])),
    ).toBe("hidden");
    expect(targetOf({ role: "button", name: "Create board" })).toBe('button "Create board"');
    expect(targetOf({ css: "#dob-month" })).toBe("#dob-month");
  });

  it("reads routes with ids as one route", () => {
    expect(routeShape("GET /comments/1x02rzo?limit=100")).toBe("GET /comments/{id}");
    expect(routeShape("GET /r/sales/new")).toBe("GET /r/{sub}/new");
    expect(routeShape("GET /api/v1/me")).toBe("GET /api/v1/me");
  });
});

describe("success report", () => {
  it("counts verdicts, misses per act, struggling runs and settled calls", () => {
    const misses = Array.from({ length: STRUGGLE }, (_, i) =>
      cmd({
        n: i + 2,
        ok: false,
        error: "locator.click: Timeout 10000ms exceeded.",
        // Older rows say no why: counted as misses, left out of the causes.
        ...(i ? { target: 'button "Create"', miss: "not-found" as const } : {}),
      }),
    );
    const r = successReport({
      since: SINCE,
      until: UNTIL,
      runs: [
        run({}),
        run({
          run: "20261006-100000-bbbb",
          outcome: "failed",
          startedAt: "2026-10-06T10:00:00.000Z",
          endedAt: "2026-10-06T11:00:00.000Z",
        }),
        run({
          run: "20261007-100000-cccc",
          outcome: "closed",
          startedAt: "2026-10-07T10:00:00.000Z",
          endedAt: "2026-10-07T11:00:00.000Z",
        }),
        run({ run: "20260901-100000-dddd", startedAt: "2026-09-01T10:00:00.000Z" }),
      ],
      cmds: [cmd({}), ...misses, cmd({ cmd: "text", n: 9 })],
      calls: [
        call({ ok: false, error: "socket" }),
        call({ attempt: 2 }),
        call({ invocation: "inv_2", ok: false, status: 400, terminal: true, error: "Too big" }),
        ...["inv_3", "inv_4"].map((invocation) =>
          call({
            invocation,
            site: "meta",
            route: "GET /instagram/a",
            ok: false,
            status: 429,
            terminal: true,
            error: "capped (reads)",
          }),
        ),
      ],
      steps: [{ at: "2026-10-05T10:00:00.000Z", site: "trello", ok: false, error: "x" }],
      models: [{ at: "2026-10-05T10:00:00.000Z", ok: true } as LlmCall],
    });
    expect(r.explore).toMatchObject({
      runs: 3,
      reached: 1,
      failed: 1,
      unknown: 1,
      successRate: 0.5,
    });
    expect(r.explore.targetMiss).toMatchObject({ n: STRUGGLE + 1, failed: STRUGGLE });
    expect(r.explore.missCauses).toEqual([{ cause: "not-found", n: STRUGGLE - 1 }]);
    expect(r.explore.missTargets).toEqual([
      { site: "trello", target: 'button "Create"', cause: "not-found", n: STRUGGLE - 1 },
    ]);
    expect(formatSuccessReport(r).join("\n")).toContain("why: not-found 2");
    expect(r.explore.struggled).toEqual([
      {
        run: "20261005-100000-aaaa",
        site: "trello",
        goal: "make a board",
        outcome: "achieved",
        failed: STRUGGLE,
      },
    ]);
    expect(r.calls).toMatchObject({
      settled: { n: 4, failed: 3 },
      capped: 2,
      tries: 5,
      retried: 1,
    });
    expect(r.calls.byFailure).toMatchObject([
      { kind: "cap", n: 2 },
      { kind: "request", n: 1 },
    ]);
    // A route over its cap ranks under one that broke, however many it was refused.
    expect(r.calls.byRoute.map((x) => [x.site, x.failed, x.capped])).toEqual([
      ["reddit", 1, 0],
      ["meta", 2, 2],
    ]);
    expect(r.steps).toMatchObject({ n: 1, failed: 1 });
    expect(formatSuccessReport(r).join("\n")).toContain("1 reached, 1 failed, 1 no verdict");
  });

  it("one site takes its accounts too", () => {
    const r = successReport({
      since: SINCE,
      until: UNTIL,
      runs: [run({}), run({ site: "trello@b" }), run({ site: "x" })],
      cmds: [],
      calls: [],
      steps: [],
      models: [],
      site: "trello",
    });
    expect(r.explore.runs).toBe(2);
  });
});

describe("import", () => {
  it("reads Restate's finished calls off their step names", () => {
    const rows = fromRestate([
      {
        id: "inv_a",
        service: "desk",
        created_at: "2026-10-09T00:00:00.000Z",
        modified_at: "2026-10-09T00:00:02.000Z",
        completion_result: "failure",
        completion_failure: "[400] Too big: expected number to be <=100",
        invoked_by_target: "RedditReads/wren/loop",
        name: "sites reddit-public GET /comments/1x02rzo",
      },
      { id: "inv_b", service: "desk", created_at: "2026-10-09T00:00:00.000Z", name: "other step" },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        site: "reddit-public",
        route: "GET /comments/1x02rzo",
        ok: false,
        status: 400,
        terminal: true,
        error: "Too big: expected number to be <=100",
        ms: 2000,
        from: "restate",
      }),
    ]);
  });

  it("keeps each caps try, numbered; skips what the ledger or Restate has", () => {
    const caps = fromCaps([
      {
        at: "2026-10-05T10:00:01.000Z",
        site: "linkedin",
        account: "a",
        route: "GET /messaging",
        use: {},
        caller: null,
        invocation: "inv_c",
        outcome: "failed",
      },
      {
        at: "2026-10-05T10:00:00.000Z",
        site: "linkedin",
        account: "a",
        route: "GET /messaging",
        use: {},
        caller: null,
        invocation: "inv_c",
        outcome: "ok",
      },
      {
        at: "2026-10-05T10:00:00.000Z",
        site: "exa",
        account: "a",
        route: "GET /search",
        use: {},
        caller: null,
        invocation: "inv_r",
        outcome: "capped",
        bucket: "exa",
      },
      {
        at: "2026-10-05T10:00:00.000Z",
        site: "exa",
        account: "a",
        route: "GET /search",
        use: {},
        caller: null,
        invocation: "inv_h",
        outcome: "ok",
      },
    ]);
    const rows = newRows(
      [call({ invocation: "inv_h" })],
      [call({ invocation: "inv_r", from: "restate" })],
      caps,
    );
    expect(rows.map((r) => [r.invocation, r.attempt, r.ok, r.from])).toEqual([
      ["inv_r", 1, true, "restate"],
      ["inv_c", 1, true, "caps"],
      ["inv_c", 2, false, "caps"],
    ]);
  });
});
