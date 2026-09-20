import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFailure, repairGoal, repairName, repairRequest } from "../src/agent/repair.js";
import type { FailureRecord } from "../src/browser/session.js";

const record: FailureRecord = {
  site: "cloudflare",
  flow: "buy-domain",
  url: "https://dash.cloudflare.com/x/domains/register",
  goal: "click Purchase",
  error: "locator.click: Timeout 10000ms exceeded.",
  kind: "failed",
  at: "2026-09-20T00:00:00.000Z",
};

describe("repair", () => {
  it("turns a failure record into an agent goal and start request", () => {
    expect(repairGoal(record)).toBe(
      'finish what the flow "buy-domain" was doing: its next act was "click Purchase". The flow stopped here with: locator.click: Timeout 10000ms exceeded.',
    );
    expect(repairGoal({ ...record, goal: null }, "buy wren-six.com")).toMatch(
      /^buy wren-six\.com\. The flow/,
    );
    expect(repairName(record)).toBe("buy-domain-repair");
    expect(repairRequest(record)).toMatchObject({ site: "cloudflare", url: record.url });
  });
  it("reads a record only from under the artifacts dir when asked", () => {
    const dir = mkdtempSync(join(tmpdir(), "repair-"));
    const file = join(dir, "x.failure.json");
    writeFileSync(file, JSON.stringify(record));
    expect(readFailure(file, dir).flow).toBe("buy-domain");
    expect(() => readFailure(file, join(dir, "elsewhere"))).toThrow(/under the artifacts dir/);
  });
});
