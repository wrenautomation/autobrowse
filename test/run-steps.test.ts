import { describe, expect, it } from "vitest";
import type { RunRow } from "../src/runs/log.js";
import { runSteps } from "../src/runs/steps.js";

const at = "2026-10-26T00:00:00.000Z";
const look = { url: "https://a.test/form", landmarks: ["main"] };
const cmd = (n: number, c: string, extra: object = {}) =>
  ({
    kind: "cmd",
    at,
    n,
    cmd: c,
    ok: true,
    error: null,
    ms: 5,
    chars: 10,
    tokens: 3,
    full: null,
    host: "a.test",
    ...extra,
  }) as RunRow;

describe("run steps", () => {
  it("pairs each command with what was read before it, its act, what came after, and the run's outcome", () => {
    const rows: RunRow[] = [
      {
        kind: "start",
        at,
        run: "r1",
        site: "a",
        driver: "console",
        goal: "sign up",
        machine: "m",
        resumed: false,
        viewport: null,
        session: "s-1",
      },
      cmd(1, "aria", { obs: "o1" }),
      {
        kind: "act",
        at,
        act: {
          kind: "fill",
          t: 1,
          url: look.url,
          target: { role: "textbox", name: "Note" },
          value: "sk-fake0000000000000000000000",
        } as never,
        look,
      },
      cmd(2, "fill", { obs: "o2", after: "a2", pics: ["p1"] }),
      { kind: "act", at, act: { kind: "click", t: 2, url: look.url } as never, look, hand: true },
      cmd(3, "click", {
        ok: false,
        error: "locator.click: Timeout",
        miss: "covered",
        obs: "o3",
        pics: ["p2"],
        boxes: [[1, 2, 3, 4]],
        session: "s-2",
      }),
      { kind: "end", at, outcome: "failed", summary: null, look },
    ];
    const steps = runSteps(rows);
    expect(steps.map((s) => s.action.cmd)).toEqual(["aria", "fill", "hand", "click"]);
    const [aria, fill, hand, click] = steps;
    expect(aria).toMatchObject({
      episode: "r1",
      goal: "sign up",
      session: "s-1",
      obs: {},
      next: { text: "o1" },
    });
    expect(fill).toMatchObject({
      obs: { text: "o1", frames: ["p1"], url: look.url },
      next: { text: "a2" },
    });
    expect(fill?.action.act).toMatchObject({ value: "<redacted>" });
    expect(hand).toMatchObject({ action: { hand: true }, obs: { text: "a2" } });
    expect(click).toMatchObject({
      step: 3,
      session: "s-2",
      obs: { text: "a2", boxes: [[1, 2, 3, 4]] },
      out: { ok: false, miss: "covered" },
    });
    expect(steps.every((s) => s.outcome === "failed")).toBe(true);
  });
});
