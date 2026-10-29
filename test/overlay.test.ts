import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { bare } from "../src/browser/bare.js";
import type { Command } from "../src/explore/commands.js";
import { overlayFor, traceRow } from "../src/explore/overlay.js";

const PAGE = `<button onclick="this.textContent='Hit'">Save</button><a href="#x">Docs</a>`;

/** Hosts we drew: our attribute name starts with `data-o`. */
const layers = `document.querySelectorAll('html > div').length`;
const ui = "window[Object.keys(window).find((k) => k.startsWith('__data-o'))]";

describe("headed overlay", () => {
  it("draws boxes and a panel outside the tree, lets presses through, and is off for a shot", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(PAGE);
      const before = await page.locator("body").ariaSnapshot();
      const o = overlayFor(true);
      const drawn = await o.set(page, {
        goal: "save the form",
        step: "1 of 25",
        thought: "the Save button submits it",
        refs: [
          { n: 1, hints: { role: "button", name: "Save" } },
          { n: 2, hints: { role: "link", name: "Docs" } },
          { n: 3, hints: { role: "button", name: "Gone" } },
        ],
      });
      // A ref whose control is not there gets no box.
      expect(drawn).toEqual({ drawn: true, boxes: 2 });
      expect(await page.evaluate(layers)).toBe(1);
      expect(await page.locator("body").ariaSnapshot()).toBe(before);
      await o.flash(page, { role: "button", name: "Save" }, "click: save");
      // The layer takes no press: the button under it gets the click.
      await page.mouse.click(10, 10);
      expect(await page.getByRole("button").textContent()).toBe("Hit");
      const during = await o.around(page, () => page.evaluate(layers));
      expect(during).toBe(0);
      expect(await page.evaluate(layers)).toBe(1);
      // Any shot through the seam (captcha, proof) gets the bare page too.
      expect(await bare(page, () => page.evaluate(layers))).toBe(0);
      await o.after(page);
      await o.remove(page);
      expect(await page.evaluate(layers)).toBe(0);
    } finally {
      await browser.close();
    }
  });

  it("by default the panel takes clicks; its toggle lets every click through", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.setContent(
        `<button id="big" style="position:fixed;inset:0;z-index:1" onclick="document.body.dataset.hits=+(document.body.dataset.hits||0)+1">x</button>`,
      );
      const o = overlayFor(true);
      await o.set(page, { goal: "save the form" });
      await o.end(page, { cmd: "click", what: "Save", ok: true, ms: 12, note: "", detail: [] });
      await page.mouse.click(40, 580);
      expect(await page.evaluate("+(document.body.dataset.hits||0)")).toBe(0);
      // The [●] button: clicks pass through from now on.
      const btn = await page.evaluate<{ x: number; y: number }>(
        `(() => { const r = [...${ui}.tuiEl.querySelectorAll('.btn')].find((b) => b.getAttribute('data-a') === 'through').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      );
      await page.mouse.click(btn.x, btn.y);
      expect(await page.evaluate(`[${ui}.through, +(document.body.dataset.hits||0)]`)).toEqual([
        true,
        0,
      ]);
      await page.mouse.click(40, 580);
      expect(await page.evaluate("+document.body.dataset.hits")).toBe(1);
      // Its buttons still take clicks in through mode.
      await page.mouse.click(btn.x, btn.y);
      expect(await page.evaluate(`[${ui}.through, +document.body.dataset.hits]`)).toEqual([
        false,
        1,
      ]);
    } finally {
      await browser.close();
    }
  });

  it("the panel takes clicks unseen by the page when idle, and none while a command runs", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      // A control under the whole panel, a field with focus, and an observer-like capture listener.
      await page.setContent(
        `<input id="f"><button id="big" style="position:fixed;inset:0;z-index:1" onclick="document.body.dataset.hits=+(document.body.dataset.hits||0)+1">x</button>
         <script>const b=document.body.dataset;b.seen=0;document.addEventListener('mousedown',()=>b.seen++,true);document.addEventListener('click',()=>b.seen++,true)</script>`,
      );
      await page.focus("#f");
      const o = overlayFor(true);
      await o.set(page, { goal: "save the form" });
      await o.begin(page);
      await o.end(page, { cmd: "click", what: "Save", ok: true, ms: 12, note: "", detail: [] });
      const panel = { x: 40, y: 580 };
      await page.mouse.click(panel.x, panel.y);
      expect(
        await page.evaluate("[+(document.body.dataset.hits||0), +document.body.dataset.seen]"),
      ).toEqual([0, 0]);
      expect(await page.evaluate("document.activeElement.id")).toBe("f");
      await o.begin(page);
      await page.mouse.click(panel.x, panel.y);
      expect(await page.evaluate("+document.body.dataset.hits")).toBe(1);
      await o.end(page, { cmd: "click", what: "x", ok: true, ms: 5, note: "", detail: [] });
      // Outside the panel, the page works as ever.
      await page.mouse.click(700, 50);
      expect(await page.evaluate("+document.body.dataset.hits")).toBe(2);
    } finally {
      await browser.close();
    }
  });

  it("hidden, the panel is a chip: the page is free where it stood, and the chip brings it back", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.setContent(
        `<button id="big" style="position:fixed;inset:0;z-index:1" onclick="document.body.dataset.hits=+(document.body.dataset.hits||0)+1">x</button>`,
      );
      const o = overlayFor(true);
      await o.set(page, { goal: "save the form" });
      await o.end(page, { cmd: "click", what: "Save", ok: true, ms: 12, note: "", detail: [] });
      // As the [×] button does.
      await page.evaluate(`${ui}.hidden = true; ${ui}.draw(${ui}.s)`);
      // A redraw from the session keeps it hidden.
      await o.end(page, { cmd: "click", what: "x", ok: true, ms: 5, note: "", detail: [] });
      await page.mouse.click(200, 500);
      expect(await page.evaluate("+document.body.dataset.hits")).toBe(1);
      // The chip, bottom left: the page never sees it.
      await page.mouse.click(30, 576);
      expect(await page.evaluate("+document.body.dataset.hits")).toBe(1);
      expect(await page.evaluate(`${ui}.hidden`)).toBe(false);
    } finally {
      await browser.close();
    }
  });

  it("the corner grip resizes the panel, and the page sees no move", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
      await page.setContent(
        `<script>const b=document.body.dataset;b.moves=0;window.addEventListener('pointermove',()=>b.moves++)</script>`,
      );
      const o = overlayFor(true);
      await o.set(page, { goal: "save the form" });
      await o.end(page, {
        cmd: "click",
        what: "Save",
        ok: true,
        ms: 12,
        note: "→ a.com/next",
        detail: [],
      });
      // Click-through mode: the grip still takes the drag.
      await page.evaluate(`${ui}.through = true; ${ui}.draw(${ui}.s)`);
      const width = () =>
        page.evaluate(`${ui}.tuiEl.getBoundingClientRect().toJSON()`) as Promise<DOMRect>;
      const before = await width();
      expect(before.width).toBe(460);
      // The grip: the panel's top right corner (panel on the left).
      await page.mouse.move(before.right - 4, before.top + 4);
      await page.evaluate("document.body.dataset.moves = 0");
      await page.mouse.down();
      await page.mouse.move(before.right + 136, before.top - 76, { steps: 5 });
      await page.mouse.move(before.right + 600, before.top - 76, { steps: 2 });
      await page.mouse.up();
      expect(await page.evaluate("+document.body.dataset.moves")).toBe(0);
      expect(await page.evaluate(`[${ui}.w, ${ui}.sized]`)).toEqual([1000 - 24, true]);
      // A redraw keeps the size.
      await o.end(page, { cmd: "click", what: "x", ok: true, ms: 5, note: "", detail: [] });
      expect((await width()).width).toBe(976);
    } finally {
      await browser.close();
    }
  });

  it("a row's note says where the page went and what changed, never a value", () => {
    const r = traceRow(
      { cmd: "click", hints: { role: "button", name: "Go" } } as Command,
      null,
      9,
      {
        from: "https://a.com/x",
        to: "https://a.com/next?token=t",
        answer: { changed: { added: ["a", "b"], gone: 3, more: 1 } },
      },
    );
    expect(r.note).toBe("→ a.com/next · +3 −3 controls");
    const read = traceRow({ cmd: "read", hints: { css: "p" } } as Command, null, 1, {
      from: "u",
      to: "u",
      answer: { as: "text", text: "secret words" },
    });
    expect(read.note).toBe("12 chars read");
    expect(JSON.stringify(read)).not.toContain("secret");
    expect(traceRow({ cmd: "click", hints: {} } as Command, new Error("gone\nstack"), 1).note).toBe(
      "gone",
    );
  });

  it("a trace row names the aim, never a typed value or a query", () => {
    const fill = traceRow(
      { cmd: "fill", hints: { role: "textbox", name: "Email" }, value: "me@x.com" } as Command,
      null,
      41.6,
    );
    expect(fill).toMatchObject({ cmd: "fill", what: 'textbox "Email"', ok: true, ms: 42 });
    expect(JSON.stringify(fill)).not.toContain("me@x.com");
    expect(traceRow({ cmd: "type", text: "secret" } as Command, null, 1).what).toBe("6 chars");
    expect(traceRow({ cmd: "open", url: "https://a.com/p?token=t" } as Command, null, 1).what).toBe(
      "a.com/p",
    );
    const bad = traceRow(
      { cmd: "click", hints: { text: "Go" } } as Command,
      new Error("no such"),
      3,
    );
    expect(bad.ok).toBe(false);
    expect(bad.detail.at(-1)).toBe("error no such");
  });

  it("toggles off and on for the session, and keeps its trace", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(PAGE);
      const o = overlayFor(true);
      await o.set(page, { goal: "save the form" });
      await o.end(page, { cmd: "click", what: "Save", ok: true, ms: 12, note: "", detail: [] });
      await o.toggle(page, false);
      expect(await page.evaluate(layers)).toBe(0);
      // Off, the session's commands draw nothing.
      await o.end(page, { cmd: "click", what: "x", ok: true, ms: 5, note: "", detail: [] });
      expect(await page.evaluate(layers)).toBe(0);
      await o.toggle(page, true);
      expect(await page.evaluate(layers)).toBe(1);
      expect(await page.evaluate(`${ui}.s.trace.length`)).toBe(1);
    } finally {
      await browser.close();
    }
  });

  it("draws nothing when off", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(PAGE);
      const o = overlayFor(false);
      expect(await o.set(page, { goal: "x" })).toEqual({ drawn: false });
      await o.flash(page, { role: "button", name: "Save" }, "click");
      expect(await page.evaluate(layers)).toBe(0);
    } finally {
      await browser.close();
    }
  });
});
