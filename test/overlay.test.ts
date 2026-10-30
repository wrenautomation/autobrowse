import { chromium, type Page } from "playwright";
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

  /** A button's centre in the panel, by its action. */
  const btnAt = (page: Page, a: string) =>
    page.evaluate<{ x: number; y: number }>(
      `(() => { const r = [...${ui}.tuiEl.querySelectorAll('[data-a]')].find((b) => b.getAttribute('data-a') === '${a}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
  const panelBox = (page: Page) =>
    page.evaluate(`${ui}.tuiEl.getBoundingClientRect().toJSON()`) as Promise<DOMRect>;
  const BIG = `<input id="f"><button id="big" style="position:fixed;inset:0;z-index:1" onclick="document.body.dataset.hits=+(document.body.dataset.hits||0)+1">x</button>
     <button id="far" style="position:fixed;right:10px;top:10px;z-index:2">far</button>
     <script>const b=document.body.dataset;b.seen=0;document.addEventListener('mousedown',()=>b.seen++,true);document.addEventListener('click',()=>b.seen++,true)</script>`;
  const hits = (page: Page) => page.evaluate("+(document.body.dataset.hits||0)");
  const seen = (page: Page) => page.evaluate("+document.body.dataset.seen");
  const row = { cmd: "click", what: "Save", ok: true, ms: 12, note: "", detail: [] };

  it("the panel takes a person's clicks unseen; an act's press on a target under it goes through", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.setContent(BIG);
      await page.focus("#f");
      const o = overlayFor(true);
      await o.set(page, { goal: "save the form" });
      await o.end(page, row);
      const p = await panelBox(page);
      // The body and the bar: the page never sees them, and focus stays.
      const before = await seen(page);
      await page.mouse.click(p.left + 40, p.bottom - 20);
      await page.mouse.click(p.left + 200, p.top + 8);
      expect([await hits(page), await seen(page)]).toEqual([0, before]);
      expect(await page.evaluate("document.activeElement.id")).toBe("f");
      // A command that only reads: the panel still takes the click.
      await o.begin(page, "read");
      await page.mouse.click(p.left + 40, p.bottom - 20);
      expect(await hits(page)).toBe(0);
      await o.end(page, row);
      // An act on a target clear of the panel: a person's click still lands on the panel.
      await o.begin(page, "click");
      await o.flash(page, { css: "#far" }, "click: far");
      await page.mouse.click(p.left + 40, p.bottom - 20);
      expect(await hits(page)).toBe(0);
      await o.after(page);
      await o.end(page, row);
      // An act on a target under the panel: the press goes through.
      await o.begin(page, "click");
      await o.flash(page, { css: "#big" }, "click: big");
      expect(Number(await page.evaluate(`getComputedStyle(${ui}.tuiEl).opacity`))).toBe(0.6);
      await page.mouse.click(p.left + 200, p.top + 8);
      expect(await hits(page)).toBe(1);
      await o.after(page);
      await o.end(page, row);
      // Hands between commands (a banner wait, a scroll): inert. The new row grew the panel up.
      const q = await panelBox(page);
      await o.hold(page, () => page.mouse.click(q.left + 200, q.top + 8));
      expect(await hits(page)).toBe(2);
      await page.mouse.click(q.left + 200, q.top + 8);
      expect(await hits(page)).toBe(2);
    } finally {
      await browser.close();
    }
  });

  it("minimized, the panel is a tab at the left edge; the tab brings it back", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.setContent(BIG);
      const o = overlayFor(true);
      await o.set(page, { goal: "save the form" });
      await o.end(page, row);
      const p = await panelBox(page);
      const min = await btnAt(page, "min");
      await page.mouse.click(min.x, min.y);
      expect(await page.evaluate(`[${ui}.min, ${ui}.tuiEl]`)).toEqual([true, null]);
      // A redraw from the session keeps it minimized; the page is free where it stood.
      await o.end(page, row);
      await page.mouse.click(p.left + 200, p.top + 8);
      expect(await hits(page)).toBe(1);
      // The tab, left edge, mid height: the page never sees it.
      await page.mouse.click(4, 300);
      expect(await hits(page)).toBe(1);
      expect(await page.evaluate(`${ui}.min`)).toBe(false);
    } finally {
      await browser.close();
    }
  });

  it("the bar drags the panel anywhere and the grip sizes it; the page sees no move", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
      await page.setContent(
        `<script>const b=document.body.dataset;b.moves=0;window.addEventListener('pointermove',()=>b.moves++)</script>`,
      );
      const o = overlayFor(true);
      await o.set(page, { goal: "save the form" });
      await o.end(page, { ...row, note: "→ a.com/next" });
      const before = await panelBox(page);
      expect(before.width).toBe(460);
      await page.evaluate("document.body.dataset.moves = 0");
      // Move: grab the bar, drop it near the top right.
      await page.mouse.move(before.left + 150, before.top + 8);
      await page.mouse.down();
      await page.mouse.move(600, 100, { steps: 5 });
      await page.mouse.up();
      const moved = await panelBox(page);
      expect([moved.left, moved.top]).toEqual([450, 92]);
      // Size: the bottom right grip.
      await page.mouse.move(moved.right - 4, moved.bottom - 4);
      await page.mouse.down();
      await page.mouse.move(moved.right + 96, moved.bottom + 196, { steps: 5 });
      await page.mouse.up();
      expect(await page.evaluate("+document.body.dataset.moves")).toBe(0);
      const sized = await panelBox(page);
      expect(Math.round(sized.width)).toBe(Math.round(moved.width + 100));
      expect(Math.round(sized.height)).toBe(Math.round(moved.height + 200));
      // A redraw keeps the place and the size.
      await o.end(page, row);
      expect(await panelBox(page)).toEqual(sized);
    } finally {
      await browser.close();
    }
  });

  it("the boxes button turns the boxes off, and off they are not looked up", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.setContent(PAGE);
      const o = overlayFor(true);
      const refs = [{ n: 1, hints: { role: "button", name: "Save" } }] as const;
      expect(await o.set(page, { goal: "x", refs: [...refs] })).toEqual({ drawn: true, boxes: 1 });
      const marks = await btnAt(page, "marks");
      await page.mouse.click(marks.x, marks.y);
      expect(await page.evaluate(`${ui}.marks`)).toBe(false);
      // Off: no count, no box, no flash.
      expect(await o.set(page, { refs: [...refs] })).toEqual({ drawn: true });
      await o.flash(page, { role: "button", name: "Save" }, "click: save");
      expect(await page.evaluate(`${ui}.s.target`)).toBeNull();
      // The flash's line grew the panel up: the button moved.
      const again = await btnAt(page, "marks");
      await page.mouse.click(again.x, again.y);
      expect(await o.set(page, { refs: [...refs] })).toEqual({ drawn: true, boxes: 1 });
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
