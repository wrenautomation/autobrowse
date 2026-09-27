import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "playwright";
import { describe, expect, it } from "vitest";
import { drawMs } from "../src/browser/human/draw.js";
import {
  aimPoint,
  BACKSPACE,
  HUMAN_PACE,
  handsFor,
  instantHands,
  mousePath,
  restAt,
  tremor,
  typingPlan,
  wanderPath,
  wheelPlan,
} from "../src/browser/human/index.js";

/** A fixed, repeatable random source. */
function seeded(seed = 7): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe("draws", () => {
  it("stay inside their range, mostly low", () => {
    for (const r of [0, 0.25, 0.5, 0.99]) {
      const ms = drawMs(HUMAN_PACE.think, () => r);
      expect(ms).toBeGreaterThanOrEqual(HUMAN_PACE.think[0]);
      expect(ms).toBeLessThanOrEqual(HUMAN_PACE.think[1]);
    }
    expect(drawMs([100, 1000], () => 0.5)).toBe(316);
  });
});

/** What a field holds after the keys: Backspace takes the last character off. */
const typedOut = (keys: { ch: string }[]) =>
  keys
    .reduce<string[]>((out, k) => (k.ch === BACKSPACE ? out.slice(0, -1) : [...out, k.ch]), [])
    .join("");

describe("typing plan", () => {
  const text = "hello there, this is William. Nothing else.";
  const plan = typingPlan(text, HUMAN_PACE.typing, seeded());

  it("types every character, in order, each held a moment", () => {
    expect(typedOut(plan)).toBe(text);
    for (const k of plan) {
      expect(k.hold).toBeGreaterThanOrEqual(HUMAN_PACE.typing.hold[0]);
      expect(k.hold).toBeLessThanOrEqual(HUMAN_PACE.typing.hold[1]);
    }
    expect(plan.at(-1)?.after).toBe(0);
  });

  it("is never one steady rate: runs, beats after punctuation", () => {
    const gaps = plan.slice(0, -1).map((k) => k.after);
    expect(new Set(gaps).size).toBeGreaterThan(gaps.length / 2);
    const comma = plan.findIndex((k) => k.ch === ",");
    expect(plan[comma]?.after).toBeGreaterThanOrEqual(HUMAN_PACE.typing.beat[0]);
  });

  it("is the same plan for the same random source", () => {
    expect(typingPlan(text, HUMAN_PACE.typing, seeded())).toEqual(plan);
  });

  it("slips onto a neighbouring key, runs on, and backs it all out", () => {
    const sloppy = { ...HUMAN_PACE.typing, typo: 1, typoRun: [3, 3] as [number, number] };
    const r = seeded();
    for (const t of ["William", "the quick brown fox", "Hi, Sam."]) {
      const keys = typingPlan(t, sloppy, r);
      expect(typedOut(keys)).toBe(t);
      expect(keys.some((k) => k.ch === BACKSPACE)).toBe(true);
    }
    // A slip of several keys: three typed, three erased, then the right one.
    const keys = typingPlan("word", sloppy, seeded());
    expect(keys.slice(3, 6).map((k) => k.ch)).toEqual([BACKSPACE, BACKSPACE, BACKSPACE]);
    expect(keys[0]?.ch).not.toBe("w");
    expect(keys[2]?.after).toBeGreaterThanOrEqual(HUMAN_PACE.typing.notice[0]);
    expect(keys[6]?.ch).toBe("w");
  });

  it("never slips on digits or symbols, nor past the end of a word", () => {
    const sloppy = { ...HUMAN_PACE.typing, typo: 1, typoRun: [3, 3] as [number, number] };
    expect(typingPlan("123-456", sloppy, seeded()).some((k) => k.ch === BACKSPACE)).toBe(false);
    // "a b": the slip on "a" cannot run on into the space.
    const keys = typingPlan("a b", sloppy, seeded());
    expect(keys.slice(0, 2).map((k) => k.ch)).toEqual([keys[0]?.ch, BACKSPACE]);
    expect(typedOut(keys)).toBe("a b");
  });

  it("counts an emoji as one keystroke", () => {
    expect(typingPlan("a👍b", HUMAN_PACE.typing, seeded()).map((k) => k.ch)).toEqual([
      "a",
      "👍",
      "b",
    ]);
  });
});

describe("mouse path", () => {
  const from = { x: 100, y: 100 };
  const to = { x: 900, y: 500 };

  it("ends exactly on the aim, curved and eased on the way", () => {
    const path = mousePath(from, to, 40, { ...HUMAN_PACE.mouse, hesitate: 0 }, seeded());
    expect(path.at(-1)).toMatchObject(to);
    // Not a straight line: some point sits off the chord.
    const off = path.map((p) =>
      Math.abs((p.x - from.x) * (to.y - from.y) - (p.y - from.y) * (to.x - from.x)),
    );
    expect(Math.max(...off)).toBeGreaterThan(0);
    // Slow at the ends, fast in the middle.
    const step = (i: number) => {
      const a = path[i - 1] ?? from;
      const b = path[i] ?? from;
      return Math.hypot(b.x - a.x, b.y - a.y);
    };
    expect(step(Math.floor(path.length / 2))).toBeGreaterThan(step(1));
  });

  it("takes longer to reach far than near (Fitts)", () => {
    const time = (t: { x: number; y: number }) =>
      mousePath(from, t, 40, { ...HUMAN_PACE.mouse, overshoot: 0 }, () => 0.5).reduce(
        (n, s) => n + s.after,
        0,
      );
    expect(time({ x: 1200, y: 800 })).toBeGreaterThan(time({ x: 140, y: 110 }));
  });

  it("sometimes overshoots a long reach and comes back", () => {
    const path = mousePath(from, to, 40, { ...HUMAN_PACE.mouse, overshoot: 1 }, seeded());
    expect(Math.max(...path.map((p) => p.x))).toBeGreaterThan(to.x);
    expect(path.at(-1)).toMatchObject(to);
  });

  it("sometimes stops part way, rests, and goes on", () => {
    const path = mousePath(
      from,
      to,
      40,
      { ...HUMAN_PACE.mouse, overshoot: 0, hesitate: 1 },
      seeded(),
    );
    expect(path.at(-1)).toMatchObject(to);
    // A run of tiny moves in the middle: the hand resting, not frozen, not travelling.
    const still = path.filter((p, i) => {
      const a = path[i - 1];
      return a && Math.hypot(p.x - a.x, p.y - a.y) < 3 && p.after > 14;
    });
    expect(still.length).toBeGreaterThan(0);
    const reach = mousePath(
      from,
      to,
      40,
      { ...HUMAN_PACE.mouse, overshoot: 0, hesitate: 0 },
      seeded(),
    );
    const time = (p: { after: number }[]) => p.reduce((n, s) => n + s.after, 0);
    expect(time(path)).toBeGreaterThan(time(reach) + HUMAN_PACE.mouse.hesitateMs[0]);
  });

  it("aims inside the control, near its middle", () => {
    const box = { x: 10, y: 20, width: 200, height: 40 };
    const r = seeded();
    for (let i = 0; i < 50; i++) {
      const p = aimPoint(box, r);
      expect(p.x).toBeGreaterThanOrEqual(box.x + box.width * 0.15);
      expect(p.x).toBeLessThanOrEqual(box.x + box.width * 0.85);
      expect(p.y).toBeGreaterThanOrEqual(box.y + box.height * 0.15);
      expect(p.y).toBeLessThanOrEqual(box.y + box.height * 0.85);
    }
  });
});

describe("idle hand", () => {
  it("trembles smoothly: neighbouring frames move together, never a jump", () => {
    const w = tremor(0.8, seeded());
    for (let ms = 0; ms < 1000; ms += 14) {
      const a = w(ms);
      const b = w(ms + 14);
      expect(Math.hypot(a.x, a.y)).toBeLessThan(2);
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(1);
    }
  });

  it("rests with a pixel or so of drift, and ends back on the spot", () => {
    const at = { x: 300, y: 200 };
    const steps = restAt(at, 600, HUMAN_PACE.mouse, seeded());
    expect(steps.reduce((n, s) => n + s.after, 0)).toBe(600);
    expect(steps.length).toBeGreaterThan(2);
    for (const p of steps) expect(Math.hypot(p.x - at.x, p.y - at.y)).toBeLessThan(2);
    expect(steps.at(-1)).toEqual({ ...at, after: 0 });
    expect(restAt(at, 0, HUMAN_PACE.mouse, seeded())).toEqual([]);
  });

  it("wanders to a few stops inside the page, resting at each", () => {
    const view = { width: 1280, height: 800 };
    const path = wanderPath(
      { x: 600, y: 400 },
      view,
      { ...HUMAN_PACE.mouse, wanderStops: [3, 3] },
      seeded(),
    );
    for (const p of path) {
      expect(p.x).toBeGreaterThan(-10);
      expect(p.x).toBeLessThan(view.width + 10);
    }
    // A rest ends back on its stop with no wait; three stops, three rests.
    const rests = path.filter((p, i) => p.after === 0 && i > 0);
    expect(rests.length).toBeGreaterThanOrEqual(3);
  });
});

describe("wheel plan", () => {
  it("scrolls in notches that add up, with looks between flicks", () => {
    const plan = wheelPlan(1500, HUMAN_PACE.scroll, seeded());
    const sum = plan.reduce((n, s) => n + s.dy, 0);
    expect(sum).toBeGreaterThanOrEqual(1500);
    expect(sum).toBeLessThan(1500 + HUMAN_PACE.scroll.notch[1]);
    expect(Math.max(...plan.map((s) => s.dy))).toBeLessThanOrEqual(HUMAN_PACE.scroll.notch[1]);
    expect(plan.some((s) => s.after >= HUMAN_PACE.scroll.look[0])).toBe(true);
    expect(wheelPlan(-300, HUMAN_PACE.scroll, seeded()).every((s) => s.dy < 0)).toBe(true);
  });
});

describe("module", () => {
  it("imports nothing from autobrowse: only Playwright types and its own files", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/browser/human");
    for (const f of readdirSync(dir)) {
      const from = [...readFileSync(join(dir, f), "utf8").matchAll(/from "([^"]+)"/g)].map(
        (m) => m[1],
      );
      for (const m of from)
        expect(m === "playwright" || /^\.\/[a-z]+\.js$/.test(m ?? "")).toBe(true);
    }
  });
});

/** A page and a control that record what the hands did. */
function fakes(
  box: { x: number; y: number; width: number; height: number } | null,
  field: { clickFocuses?: boolean; keysLand?: boolean } = {},
) {
  const log: string[] = [];
  const { clickFocuses = true, keysLand = true } = field;
  const state = { focused: false, value: "" };
  const page = {
    viewportSize: () => ({ width: 1280, height: 800 }),
    mouse: {
      move: async (x: number, y: number) => void log.push(`move ${Math.round(x)},${Math.round(y)}`),
      wheel: async (_x: number, dy: number) => void log.push(`wheel ${dy}`),
    },
    keyboard: {
      type: async (t: string, o?: { delay?: number }) => {
        log.push(`key ${t} ${o?.delay ?? 0}`);
        if (state.focused && keysLand) state.value += t;
      },
      press: async (k: string) => void log.push(`press ${k}`),
      insertText: async (t: string) => void log.push(`insert ${t.length}`),
    },
    waitForTimeout: async () => {},
  } as unknown as Page;
  const target = {
    page: () => page,
    scrollIntoViewIfNeeded: async () => {},
    boundingBox: async () => box,
    click: async (o: { position?: { x: number; y: number }; delay?: number }) => {
      log.push(
        o.position
          ? `click at ${Math.round(o.position.x)},${Math.round(o.position.y)} held ${o.delay}`
          : "click plain",
      );
      state.focused = clickFocuses;
    },
    focus: async () => {
      log.push("focus");
      state.focused = true;
    },
    evaluate: async () => state.focused,
    inputValue: async () => state.value,
    fill: async (v: string) => {
      log.push(`fill ${v.length}`);
      state.value = v;
    },
    pressSequentially: async (ch: string, o: { delay: number }) =>
      void log.push(`key ${ch} ${o.delay}`),
    press: async (k: string) => void log.push(`press ${k}`),
  } as unknown as Locator;
  return { log, page, target };
}

/** Hands that never slip, for tests about the order of keys. */
const neat = { ...HUMAN_PACE, typing: { ...HUMAN_PACE.typing, typo: 0 } };

describe("hands", () => {
  it("reach the control along a path, then click inside it with the button held", async () => {
    const { log, target } = fakes({ x: 400, y: 300, width: 120, height: 30 });
    await handsFor(HUMAN_PACE, seeded()).click(target, { timeout: 1000 });
    const moves = log.filter((l) => l.startsWith("move"));
    expect(moves.length).toBeGreaterThan(5);
    const click = log.at(-1) ?? "";
    const [, x, y, held] = click.match(/^click at (\d+),(\d+) held (\d+)$/) ?? [];
    expect(Number(x)).toBeGreaterThan(0);
    expect(Number(x)).toBeLessThan(120);
    expect(Number(y)).toBeLessThan(30);
    expect(Number(held)).toBeGreaterThanOrEqual(HUMAN_PACE.mouse.hold[0]);
  });

  it("wheel a control below the fold into view before reaching for it", async () => {
    const { log, target } = fakes({ x: 400, y: 2300, width: 120, height: 30 });
    await handsFor(HUMAN_PACE, seeded()).click(target, { timeout: 1000 });
    const wheels = log.filter((l) => l.startsWith("wheel")).map((l) => Number(l.split(" ")[1]));
    expect(wheels.length).toBeGreaterThan(5);
    expect(wheels.reduce((n, d) => n + d, 0)).toBeGreaterThan(1500);
    expect(log.at(-1)).toMatch(/^click at/);
  });

  it("fall back to a plain click when the control has no box", async () => {
    const { log, target } = fakes(null);
    await handsFor(HUMAN_PACE, seeded()).click(target, { timeout: 1000 });
    expect(log).toEqual(["click plain"]);
  });

  it("clear the field, then type it key by key", async () => {
    const { log, target } = fakes({ x: 0, y: 0, width: 100, height: 20 });
    await handsFor(neat, seeded()).type(target, "hi", { timeout: 1000 });
    expect(log.filter((l) => /^(fill|key)/.test(l)).map((l) => l.replace(/ \d+$/, ""))).toEqual([
      "fill",
      "key h",
      "key i",
    ]);
  });

  it("focus the control when the click left focus elsewhere", async () => {
    const { log, target } = fakes({ x: 0, y: 0, width: 100, height: 20 }, { clickFocuses: false });
    await handsFor(neat, seeded()).type(target, "hi", { timeout: 1000 });
    expect(
      log.filter((l) => /^(focus|fill|key)/.test(l)).map((l) => l.replace(/ \d+$/, "")),
    ).toEqual(["focus", "fill", "key h", "key i"]);
  });

  it("fill the field when the keys landed nowhere", async () => {
    const { log, target } = fakes({ x: 0, y: 0, width: 100, height: 20 }, { keysLand: false });
    await handsFor(neat, seeded()).type(target, "hi", { timeout: 1000 });
    expect(log.at(-1)).toBe("fill 2");
  });

  it("back a slip out with Backspace", async () => {
    const { log, page } = fakes(null);
    const sloppy = {
      ...HUMAN_PACE,
      typing: { ...HUMAN_PACE.typing, typo: 1, typoRun: [1, 1] as [number, number] },
    };
    await handsFor(sloppy, seeded()).type(page, "ok", { timeout: 1000 });
    const keys = log.map((l) => l.replace(/ \d+$/, ""));
    expect(keys).toContain(`press ${BACKSPACE}`);
    const played = keys.map((k) => ({ ch: k === `press ${BACKSPACE}` ? BACKSPACE : k.slice(4) }));
    expect(typedOut(played)).toBe("ok");
  });

  it("paste long text instead of typing it", async () => {
    const { log, target } = fakes({ x: 0, y: 0, width: 100, height: 20 });
    await handsFor(HUMAN_PACE, seeded()).type(target, "x".repeat(500), { timeout: 1000 });
    expect(log.filter((l) => l.startsWith("key"))).toEqual([]);
    expect(log.at(-1)).toBe("fill 500");
  });

  it("type at the caret when handed a page", async () => {
    const { log, page } = fakes(null);
    await handsFor(neat, seeded()).type(page, "ok", { timeout: 1000 });
    expect(log.map((l) => l.replace(/ \d+$/, ""))).toEqual(["key o", "key k"]);
  });

  it("are instant with no pace", () => {
    expect(handsFor(null)).toBe(instantHands);
  });
});
