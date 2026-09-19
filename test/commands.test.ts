import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/channels/commands.js";

describe("parseCommand", () => {
  it("reads short answers, with an optional run and note", () => {
    expect(parseCommand("yes")).toEqual({ kind: "approve", run: null, note: null });
    expect(parseCommand("No thanks")).toEqual({ kind: "reject", run: null, note: "thanks" });
    expect(parseCommand("yes domain wren-six.com")).toEqual({
      kind: "approve",
      run: { workflow: "domain", key: "wren-six.com" },
      note: null,
    });
    expect(parseCommand("approve domain wren-six.com - price is fine")).toEqual({
      kind: "approve",
      run: { workflow: "domain", key: "wren-six.com" },
      note: "price is fine",
    });
  });
  it("reads verbs", () => {
    expect(parseCommand("pause")).toEqual({ kind: "pause", run: null });
    expect(parseCommand("resume domain a.test")).toEqual({
      kind: "play",
      run: { workflow: "domain", key: "a.test" },
    });
    expect(parseCommand("Status")).toEqual({ kind: "status", run: null });
  });
  it("ignores chatter", () => {
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("what is this?")).toBeNull();
    expect(parseCommand("yesterday was fine")).toBeNull();
  });
});
