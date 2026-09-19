import { describe, expect, it } from "vitest";
import { ALL_GUARDS, parseGuards } from "../src/engine/guards.js";
import { runFlow } from "../src/engine/run.js";
import { domainWorkflow } from "../src/workflows/domain/index.js";
import { fakeDeps, fakeEffects, scriptedAnswers } from "./fakes.js";

const plan = () =>
  domainWorkflow.plan.parse({
    domain: "wren-nine.com",
    inboxes: [{ local: "will", givenName: "W", familyName: "J" }],
  });

describe("guards", () => {
  it("parses all, none, and lists; rejects unknown names", () => {
    expect(parseGuards(undefined)).toEqual(ALL_GUARDS);
    expect(parseGuards("none").size).toBe(0);
    expect([...parseGuards("purchase, password")]).toEqual(["purchase", "password"]);
    expect(() => parseGuards("teleport")).toThrow(/unknown guard/);
  });
  it("with the purchase guard on, the run waits at the gate", async () => {
    const out = await runFlow(fakeEffects().fx, domainWorkflow, fakeDeps(), plan());
    expect(out.status).toBe("waiting");
  });
  it("with the purchase guard off, the gate answers itself and the run buys", async () => {
    const deps = fakeDeps();
    const out = await runFlow(fakeEffects().fx, domainWorkflow, deps, plan(), () => null, {
      guards: parseGuards("password,irreversible"),
    });
    expect(out.results.buy?.status).toBe("done");
    expect(deps.calls).toContain("buy wren-nine.com");
  });
});

describe("password guard", () => {
  const two = () =>
    domainWorkflow.plan.parse({
      domain: "wren-nine.com",
      inboxes: [
        { local: "will", givenName: "W", familyName: "J" },
        { local: "hello", givenName: "W", familyName: "J" },
      ],
    });
  it("asks before resetting an existing inbox and stops when declined", async () => {
    const deps = fakeDeps();
    await deps.google.createUser({
      primaryEmail: "will@wren-nine.com",
      givenName: "W",
      familyName: "J",
      password: "x",
    });
    deps.calls.length = 0;
    const answers = scriptedAnswers({
      purchase: [{ approved: true }],
      password: [{ approved: false, note: "keep it" }],
    });
    const out = await runFlow(fakeEffects().fx, domainWorkflow, deps, two(), answers.answer);
    expect(answers.asked).toContain("password");
    expect(out.status).toBe("rejected");
    expect(deps.calls.filter((c) => c.startsWith("setPassword"))).toEqual([]);
  });
  it("does not ask when every inbox is new", async () => {
    const answers = scriptedAnswers({ purchase: [{ approved: true }] });
    await runFlow(fakeEffects().fx, domainWorkflow, fakeDeps(), two(), answers.answer);
    expect(answers.asked).not.toContain("password");
  });
});
