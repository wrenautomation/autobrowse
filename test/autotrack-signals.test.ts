import { describe, expect, it } from "vitest";
import { splitEpisodes, splitUnmarked } from "../src/autotrack/episodes.js";
import { type Act, buildActs, JOIN_MS, JOIN_PX, joinClicks } from "../src/autotrack/join.js";
import {
  correctionFlags,
  dwellOf,
  hasError,
  hoverOf,
  isDead,
  rageFlags,
  signalsFor,
} from "../src/autotrack/signals.js";
import type { Event } from "../src/autotrack/types.js";
import { APP, at, CHROME, click, el, key, T0, text, web } from "./autotrack-events.js";

type Click = Extract<Event, { kind: "click" }>;
type Web = Extract<Event, { kind: "web" }>;

/** The first act of a list. */
const one = (events: Event[]): Act => buildActs(events)[0] as Act;

describe("join: OS click and web click", () => {
  const os = (ms: number, x = 100, y = 100) => click(ms, x, y) as Click;
  const wc = (ms: number, x = 100, y = 100) => web(ms, "click", { x, y }) as Web;

  it("joins inside 150 ms and 4 px, not at the edges", () => {
    expect(joinClicks([os(1000)], [wc(1000 + JOIN_MS - 1)]).size).toBe(1);
    expect(joinClicks([os(1000)], [wc(1000 + JOIN_MS)]).size).toBe(0);
    expect(joinClicks([os(1000)], [wc(1000 - JOIN_MS + 1)]).size).toBe(1);
    expect(joinClicks([os(1000)], [wc(1000, 100 + JOIN_PX, 100)]).size).toBe(1);
    expect(joinClicks([os(1000)], [wc(1000, 100 + JOIN_PX + 1, 100)]).size).toBe(0);
    expect(joinClicks([os(1000)], [wc(1000, 103, 103)]).size).toBe(0); // 4.24 px
  });

  it("spends both ends once: two quick clicks never share a browser event", () => {
    const a = os(1000);
    const b = os(1100);
    const w = wc(1090);
    const m = joinClicks([a, b], [w]);
    expect(m.size).toBe(1);
    expect(m.get(b)).toBe(w);
  });

  it("the web target enriches a thin OS element, but not a named one", () => {
    const target = { tag: "button", role: "button", name: "Approve", href: undefined };
    const thin = buildActs([
      click(1000, 100, 100, { element: el("", { role: "AXGroup" }) }),
      web(1010, "click", { x: 100, y: 100, target }),
    ]);
    expect(thin).toHaveLength(1);
    expect(thin[0]?.element?.name).toBe("Approve");
    expect(thin[0]?.target?.tag).toBe("button");
    const named = buildActs([
      click(1000, 100, 100, { element: el("Save") }),
      web(1010, "click", { x: 100, y: 100, target }),
    ]);
    expect(named[0]?.element?.name).toBe("Save");
    expect(named[0]?.target?.name).toBe("Approve");
  });

  it("an unmatched web click is its own act; an unmatched dblclick is dropped", () => {
    const a = buildActs([
      web(1000, "click", { x: 5, y: 5 }),
      web(5000, "dblclick", { x: 5, y: 5 }),
    ]);
    expect(a.map((x) => x.kind)).toEqual(["click"]);
  });

  it("folds effects into the act that caused them, even a second later", () => {
    const a = buildActs([
      click(1000),
      web(1005, "click", { x: 100, y: 100 }),
      web(2005, "effect", {
        cause: { act: "click", ts: T0 + 1005 },
        effects: {
          url: "https://app.example.com/b",
          requests: [{ method: "POST", url: "https://app.example.com/api", status: 200, ms: 40 }],
          dom: { added: 3, removed: 0, textChanged: 1 },
        },
      }),
    ]);
    expect(a).toHaveLength(1);
    expect(a[0]?.effects?.requests).toHaveLength(1);
    expect(a[0]?.effects?.url).toBe("https://app.example.com/b");
  });

  it("a link's navigation attaches to the click; a typed one is an act", () => {
    const a = buildActs([
      click(1000),
      web(1005, "click", { x: 100, y: 100 }),
      web(1400, "nav", { transition: "link", url: "https://app.example.com/b" }),
      web(9000, "nav", { transition: "typed", url: "https://other.example.org/" }),
    ]);
    expect(a.map((x) => x.kind)).toEqual(["click", "nav"]);
    expect(a[0]?.navs).toHaveLength(1);
  });

  it("a copy joins its ctrl+c; a search swallows the page load it caused", () => {
    const a = buildActs([
      key(1000, "c", ["meta"]),
      web(1100, "copy", { text: "hello" }),
      web(3000, "search", { engine: "google", query: "invoices" }),
      web(3100, "nav", {
        transition: "generated",
        url: "https://www.google.com/search?q=invoices",
      }),
    ]);
    expect(a.map((x) => x.kind)).toEqual(["key", "search"]);
    expect(a[0]?.web?.text).toBe("hello");
  });

  it("scroll events in a run are one act with summed distance", () => {
    const a = buildActs([
      at(1000, { kind: "scroll", x: 1, y: 1, dx: 0, dy: -3, app: APP }),
      at(1300, { kind: "scroll", x: 1, y: 1, dx: 0, dy: -4, app: APP }),
      at(9000, { kind: "scroll", x: 1, y: 1, dx: 0, dy: 2, app: APP }),
    ]);
    expect(a).toHaveLength(2);
    expect(a[0]?.event.kind === "scroll" && a[0].event.dy).toBe(-7);
    expect(a[0]?.end).toBe(T0 + 1300);
  });
});

describe("signals", () => {
  it("dwell is the gap after the previous act", () => {
    const a = buildActs([click(1000), click(4000, 300, 300)]);
    expect(dwellOf(a, 0)).toBe(0);
    expect(dwellOf(a, 1)).toBe(3000);
  });

  describe("rage", () => {
    it("a double click is not rage", () => {
      const a = buildActs([click(1000), click(1150)]);
      expect(rageFlags(a)).toEqual([false, false]);
    });
    it("three clicks on one spot inside 2 s flag every click", () => {
      const a = buildActs([click(1000), click(1400), click(1800)]);
      expect(rageFlags(a)).toEqual([true, true, true]);
    });
    it("three clicks spread over more than 2 s are not rage", () => {
      const a = buildActs([click(1000), click(2500), click(4000)]);
      expect(rageFlags(a)).toEqual([false, false, false]);
    });
    it("three clicks on different controls are not rage", () => {
      const a = buildActs([click(1000, 10, 10), click(1300, 200, 10), click(1600, 400, 10)]);
      expect(rageFlags(a)).toEqual([false, false, false]);
    });
    it("a triple click made by one OS event (count 3) is not rage either", () => {
      const a = buildActs([click(1000, 100, 100, { count: 3 })]);
      expect(rageFlags(a)).toEqual([false]);
    });
  });

  describe("correction", () => {
    it("a backspace run over just-typed text is a correction", () => {
      const a = buildActs([text(1000, "helo"), key(2000, "backspace"), key(2100, "backspace")]);
      expect(correctionFlags(a)).toEqual([false, true, true]);
    });
    it("a backspace run that is not over just-typed text is not", () => {
      const a = buildActs([click(1000), key(2000, "backspace"), key(2100, "backspace")]);
      expect(correctionFlags(a)).toEqual([false, false, false]);
    });
    it("a backspace run long after the text, behind another act, is not", () => {
      const a = buildActs([text(1000, "abc"), click(3000, 300, 300), key(4000, "backspace")]);
      expect(correctionFlags(a)).toEqual([false, false, false]);
    });
    it("a backspace run after typing long ago is editing, not correcting", () => {
      const a = buildActs([text(1000, "ab"), key(600_000, "backspace")]);
      expect(correctionFlags(a)).toEqual([false, false]);
    });
    it("text typed and erased whole is a correction", () => {
      const a = buildActs([text(1000, "")]);
      expect(correctionFlags(a)).toEqual([true]);
    });
    it("a redacted run with empty text is not an erase", () => {
      const a = buildActs([text(1000, "", { redacted: true })]);
      expect(correctionFlags(a)).toEqual([false]);
    });
    it("undo is a correction, redo is not", () => {
      const a = buildActs([key(1000, "z", ["meta"]), key(2000, "z", ["meta", "shift"])]);
      expect(correctionFlags(a)).toEqual([true, false]);
    });
    it("back within 5 s of the act is a correction, later is not", () => {
      const quick = buildActs([click(1000), key(3000, "left", ["alt"])]);
      expect(correctionFlags(quick)).toEqual([false, true]);
      const slow = buildActs([click(1000), key(30_000, "left", ["alt"])]);
      expect(correctionFlags(slow)).toEqual([false, false]);
      const nav = buildActs([
        click(1000),
        web(2000, "nav", { transition: "back_forward", url: "https://app.example.com/" }),
      ]);
      expect(correctionFlags(nav)).toEqual([false, true]);
    });
  });

  describe("dead", () => {
    const none = { dialogs: [], focuses: [] };
    it("no evidence is not dead", () => {
      expect(isDead(one([click(1000)]), none)).toBe(false);
    });
    it("measured and nothing changed is dead", () => {
      const out = { screen: false, focus: false, dialog: false, window: false };
      expect(isDead(one([click(1000, 1, 1, { out })]), none)).toBe(true);
    });
    it("any change in the outcome is not dead", () => {
      const out = { screen: true, focus: false, dialog: false, window: false };
      expect(isDead(one([click(1000, 1, 1, { out })]), none)).toBe(false);
    });
    it("a web click with requests or DOM changes is not dead; with none, it is", () => {
      const dom = { added: 0, removed: 0, textChanged: 0 };
      const mk = (effects: object) =>
        one([
          web(1000, "click", { x: 5, y: 5 }),
          web(2000, "effect", { cause: { act: "click", ts: T0 + 1000 }, effects }),
        ]);
      expect(isDead(mk({ requests: [], dom }), none)).toBe(true);
      expect(isDead(mk({ requests: [], dom: { ...dom, added: 1 } }), none)).toBe(false);
      expect(
        isDead(mk({ requests: [{ method: "GET", url: "u", status: 200, ms: 1 }], dom }), none),
      ).toBe(false);
    });
    it("a dialog or focus change right after is not dead", () => {
      const out = { screen: false, focus: false, dialog: false, window: false };
      const a = one([click(1000, 1, 1, { out })]);
      const dialog = at(1200, {
        kind: "dialog",
        title: "t",
        text: "x",
        buttons: ["OK"],
      }) as Extract<Event, { kind: "dialog" }>;
      expect(isDead(a, { dialogs: [dialog], focuses: [] })).toBe(false);
    });
    it("a scroll or a key is never dead", () => {
      const out = { screen: false, focus: false, dialog: false, window: false };
      expect(isDead(one([key(1000, "a")]), none)).toBe(false);
      expect(
        isDead(one([at(1000, { kind: "scroll", x: 1, y: 1, dx: 0, dy: 1, out, app: APP })]), none),
      ).toBe(false);
    });
  });

  describe("hover", () => {
    const move = (ms: number, x: number, y: number) =>
      at(ms, { kind: "move", x, y }) as Extract<Event, { kind: "move" }>;
    it("counts the unbroken run of moves on the target before the click", () => {
      const a = one([
        click(5000, 100, 100, { element: el("Go", { x: 80, y: 80, width: 60, height: 40 }) }),
      ]);
      const moves = [
        move(1000, 400, 400),
        move(3000, 100, 100),
        move(3500, 105, 102),
        move(4500, 99, 99),
      ];
      expect(hoverOf(a, moves, Number.NEGATIVE_INFINITY)).toBe(2000);
    });
    it("is undefined when the pointer never rested there, and for non-pointer acts", () => {
      const a = one([click(5000, 100, 100, { element: el("Go") })]);
      expect(
        hoverOf(a, [move(1000, 400, 400), move(4000, 500, 500)], Number.NEGATIVE_INFINITY),
      ).toBeUndefined();
      expect(hoverOf(one([key(1000, "a")]), [], 0)).toBeUndefined();
    });
    it("does not reach back past the previous act", () => {
      const a = one([click(5000, 100, 100, { element: el("Go") })]);
      expect(hoverOf(a, [move(1000, 100, 100), move(4000, 100, 100)], T0 + 3500)).toBe(1000);
    });
  });

  it("errors: a failed request, a console error or a dialog", () => {
    const dom = { added: 0, removed: 0, textChanged: 0 };
    const mk = (effects: object) =>
      one([
        web(1000, "click", { x: 5, y: 5 }),
        web(1500, "effect", { cause: { act: "click", ts: T0 + 1000 }, effects }),
      ]);
    expect(
      hasError(mk({ requests: [{ method: "POST", url: "u", status: 500, ms: 1 }], dom }), []),
    ).toBe(true);
    expect(
      hasError(mk({ requests: [{ method: "GET", url: "u", status: 200, ms: 1 }], dom }), []),
    ).toBe(false);
    expect(
      hasError(mk({ requests: [], dom, errors: [{ message: "boom", source: "x.js" }] }), []),
    ).toBe(true);
    const a = one([click(1000)]);
    const d = at(1500, { kind: "dialog", title: "Error", text: "x", buttons: [] }) as Extract<
      Event,
      { kind: "dialog" }
    >;
    expect(hasError(a, [d])).toBe(true);
  });

  it("signalsFor returns one row per act with hover only when known", () => {
    const events = [
      at(1000, { kind: "move", x: 100, y: 100 }),
      click(2000, 100, 100, { element: el("Go") }),
      key(3000, "a"),
    ];
    const s = signalsFor(buildActs(events), events);
    expect(s).toHaveLength(2);
    expect(s[0]?.hover).toBe(1000);
    expect(s[1]).not.toHaveProperty("hover");
  });
});

describe("episodes", () => {
  const sec = (n: number) => n * 1000;
  const inChrome = (ms: number, url: string) => web(ms, "click", { x: ms, y: 5, url });

  it("one stretch of steady work is one episode", () => {
    const events = [click(sec(1)), click(sec(20), 200, 200), click(sec(40), 300, 300)];
    const eps = splitEpisodes(buildActs(events), events);
    expect(eps).toHaveLength(1);
    expect([eps[0]?.from, eps[0]?.to]).toEqual([0, 3]);
  });

  it("splits on a 2 minute idle gap, not on 119 s", () => {
    const events = [
      click(sec(1)),
      click(sec(1 + 119), 200, 200),
      click(sec(1 + 119 + 120), 300, 300),
    ];
    const eps = splitEpisodes(buildActs(events), events);
    expect(eps.map((e) => [e.from, e.to])).toEqual([
      [0, 2],
      [2, 3],
    ]);
  });

  it("task markers split and name the goal; a marked stretch is not split again", () => {
    const events = [
      click(sec(1)),
      at(sec(10), { kind: "task", goal: "pay the invoice" }),
      click(sec(11)),
      click(sec(400), 200, 200),
      at(sec(500), { kind: "task", goal: "", done: true }),
      click(sec(501), 300, 300),
    ];
    const eps = splitEpisodes(buildActs(events), events);
    expect(eps.map((e) => [e.from, e.to, e.goal])).toEqual([
      [0, 1, undefined],
      [1, 3, "pay the invoice"],
      [3, 4, undefined],
    ]);
  });

  it("an unrelated domain held for 30 s splits; a short visit does not", () => {
    const home = (ms: number) => inChrome(ms, "https://app.example.com/x");
    const away = (ms: number) => inChrome(ms, "https://news.other.org/y");
    const held = [home(sec(1)), away(sec(10)), away(sec(45)), home(sec(50))];
    expect(splitUnmarked(buildActs(held), 0, 4)).toEqual([1]);
    const brief = [home(sec(1)), away(sec(10)), home(sec(20)), home(sec(30))];
    expect(splitUnmarked(buildActs(brief), 0, 4)).toEqual([]);
  });

  it("a subdomain of the same site is not a switch", () => {
    const events = [
      inChrome(sec(1), "https://app.example.com/x"),
      inChrome(sec(40), "https://docs.example.com/y"),
      inChrome(sec(100), "https://docs.example.com/z"),
    ];
    expect(splitUnmarked(buildActs(events), 0, 3)).toEqual([]);
  });

  it("a different app held for 30 s splits", () => {
    const other = { name: "Slack", id: "com.slack", pid: 9 };
    const events = [
      click(sec(1)),
      click(sec(5), 10, 10, { app: other }),
      click(sec(50), 20, 20, { app: other }),
    ];
    expect(splitUnmarked(buildActs(events), 0, 3)).toEqual([1]);
    void CHROME;
  });

  it("no acts, no episodes", () => {
    expect(splitEpisodes([], [at(1000, { kind: "task", goal: "x" })])).toEqual([]);
  });
});
