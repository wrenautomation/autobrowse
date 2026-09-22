import { describe, expect, it } from "vitest";
import type { RunStatusView } from "../src/engine/object.js";
import type { SiteRow } from "../src/sites/index.js";
import {
  needAffordances,
  runAffordances,
  setupAffordances,
  setupPath,
} from "../src/ui/affordances.js";

const run = (o: Partial<RunStatusView>): RunStatusView => ({
  workflow: "aws-port25-request",
  key: "wren-prod-pg",
  plan: {},
  gate: null,
  paused: false,
  outcome: null,
  ...o,
});
const rels = (a: { rel: string }[]) => a.map((x) => x.rel);

describe("run affordances", () => {
  it("offers the gate's answers while one is open, and not `run`", () => {
    const a = runAffordances(
      run({
        gate: { name: "send", step: "submit", prompt: "send it?", openedAt: "now" },
      }),
    );
    expect(rels(a)).toEqual(["approve", "reject", "pause"]);
    expect(a[0]?.path).toBe("/api/runs/aws-port25-request/wren-prod-pg/approve");
  });

  it("offers play instead of pause when paused", () => {
    expect(rels(runAffordances(run({ paused: true })))).toContain("play");
  });

  it("offers run and reset once it finished, and says how it ended", () => {
    const a = runAffordances(run({ outcome: { status: "failed", results: {}, memo: {} } }));
    expect(rels(a)).toEqual(["pause", "run", "reset"]);
    expect(a.find((x) => x.rel === "run")?.note).toBe("last run failed");
  });

  it("offers run on a key that never ran", () => {
    expect(rels(runAffordances(run({})))).toEqual(["pause", "run"]);
  });
});

const site = (setup: SiteRow["setup"]): SiteRow => ({
  site: "langfuse",
  origin: "https://cloud.langfuse.com",
  authed: true,
  routes: [],
  setup,
});

describe("setup affordances", () => {
  it("only steps that are not done, not blocked and have a flow", () => {
    const a = setupAffordances(
      site([
        { name: "keys", makes: ["A"], done: true, blockedOn: [] },
        { name: "consent", makes: ["B"], done: false, blockedOn: ["A"] },
        { name: "app", makes: ["C"], done: false, blockedOn: [], unrecorded: "workflow x" },
        { name: "project-keys", makes: ["D", "E"], done: false, blockedOn: [] },
      ] as SiteRow["setup"]),
    );
    expect(a).toEqual([
      {
        rel: "setup",
        method: "POST",
        path: "/api/sites/langfuse/setup/project-keys",
        note: "makes D, E",
      },
    ]);
  });
});

describe("need affordances", () => {
  it("turns a `site setup` command into the same step over HTTP", () => {
    const a = needAffordances({
      id: "keys-linkedin",
      done: false,
      by: null,
      how: ["autobrowse site setup linkedin developer-app", "or make the app by hand"],
      checked: true,
    });
    expect(a[0]).toMatchObject({
      rel: "setup",
      path: "/api/sites/linkedin/setup/developer-app",
    });
    expect(rels(a)).toEqual(["setup", "done"]);
  });

  it("carries the account through", () => {
    expect(setupPath("autobrowse site setup gmail consent --account a@b.com")).toBe(
      "/api/sites/gmail/setup/consent?account=a%40b.com",
    );
  });

  it("a row a check cleared offers nothing; one you marked can be undone", () => {
    const row = { id: "x", how: [], checked: false };
    expect(needAffordances({ ...row, done: true, by: "check" })).toEqual([]);
    expect(rels(needAffordances({ ...row, done: true, by: "you" }))).toEqual(["undo"]);
  });
});
