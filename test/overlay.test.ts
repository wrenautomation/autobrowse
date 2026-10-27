import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { overlayFor } from "../src/explore/overlay.js";

const PAGE = `<button onclick="this.textContent='Hit'">Save</button><a href="#x">Docs</a>`;

/** Hosts we drew: our attribute name starts with `data-o`. */
const layers = `document.querySelectorAll('html > div').length`;

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
      await o.after(page);
      await o.remove(page);
      expect(await page.evaluate(layers)).toBe(0);
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
