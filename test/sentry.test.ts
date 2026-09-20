import { describe, expect, it } from "vitest";
import { issueOf } from "../src/app/sentry.js";

const run = { workflow: "domain", key: "x.com" };
describe("issueOf", () => {
  it("only failed steps and failed runs become issues, tagged for grouping", () => {
    expect(
      issueOf({
        type: "step",
        run,
        at: "",
        step: "buy",
        result: { status: "failed", detail: "no Purchase button", at: "" },
      }),
    ).toEqual({
      message: "domain/buy: no Purchase button",
      tags: { workflow: "domain", key: "x.com", step: "buy" },
    });
    expect(
      issueOf({ type: "finished", run, at: "", status: "failed", summary: "buy failed" }),
    ).toEqual({
      message: "domain/x.com failed: buy failed",
      tags: { workflow: "domain", key: "x.com" },
    });
    expect(issueOf({ type: "finished", run, at: "", status: "done", summary: "ok" })).toBeNull();
    expect(
      issueOf({
        type: "step",
        run,
        at: "",
        step: "buy",
        result: { status: "done", detail: "", at: "" },
      }),
    ).toBeNull();
  });
});
