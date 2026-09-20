import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeEvidence, proposeWorkflows, readFailures } from "../src/agent/evaluator.js";
import type { FailureRecord } from "../src/browser/session.js";
import { fakeLlm } from "../src/llm/fake.js";

const failure = (n: number, over: Partial<FailureRecord> = {}): FailureRecord => ({
  site: "google-admin",
  flow: "add-user",
  url: "https://accounts.google.com/signin/challenge",
  goal: "click Add new user",
  error: "still on the sign-in page after signing in",
  kind: "failed",
  at: `2026-09-2${n}T00:00:00.000Z`,
  ...over,
});

describe("evaluator", () => {
  it("reads failure records newest first and skips junk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-"));
    writeFileSync(join(dir, "a.failure.json"), JSON.stringify(failure(1)));
    writeFileSync(join(dir, "b.failure.json"), JSON.stringify(failure(3)));
    writeFileSync(join(dir, "c.failure.json"), "{not json");
    writeFileSync(join(dir, "d.png"), "x");
    expect((await readFailures(dir)).map((f) => f.at.slice(8, 10))).toEqual(["23", "21"]);
    expect(await readFailures("/nowhere/at/all")).toEqual([]);
  });
  it("hands the model grouped evidence and returns ranked proposals", async () => {
    const llm = fakeLlm([
      {
        proposals: [
          { title: "b", why: "w", site: "s", goal: "g", occurrences: 1, covered: false },
          {
            title: "Google admin re-auth",
            why: "3 flows stop at the challenge",
            site: "google-admin",
            goal: "sign in through the challenge and land on admin.google.com",
            occurrences: 3,
            covered: false,
          },
        ],
      },
    ]);
    const { proposals } = await proposeWorkflows(llm, {
      failures: [failure(1), failure(2), failure(3, { flow: "set-logo" })],
      sessions: [
        {
          site: "google",
          goal: "find the name",
          status: "done",
          achieved: true,
          summary: "William",
          recordingName: "google-name",
        },
      ],
      recordings: [{ name: "google-name", site: "google" }],
      workflows: [{ name: "domain", description: "Buy a domain" }],
    });
    expect(proposals.map((p) => p.title)).toEqual(["Google admin re-auth", "b"]);
    const prompt = llm.requests[0]?.prompt ?? "";
    expect(prompt).toContain("FLOW FAILURES (3)");
    expect(prompt).toContain("google-admin/set-logo failed");
    expect(prompt).toContain("(saved as google-name)");
    expect(prompt).toContain("WORKFLOWS THAT ALREADY RUN (1):\n- domain: Buy a domain");
  });
  it("asks nothing when there is no evidence", async () => {
    const llm = fakeLlm([]);
    const r = await proposeWorkflows(llm, { failures: [], sessions: [], recordings: [] });
    expect(r.proposals).toEqual([]);
    expect(llm.requests).toHaveLength(0);
  });
  it("describes evidence without the model", () => {
    const text = describeEvidence({ failures: [], sessions: [], recordings: [] });
    expect(text).toContain("(none)");
  });
});
