import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { snapshotPage } from "../src/browser/repair.js";
import { BINDING, OBSERVER_SCRIPT } from "../src/recorder/observer.js";

/** A web component's controls in an open shadow root, a composer div, and a plain button. */
const PAGE = `<button>Light</button><x-card></x-card>
<div contenteditable="true" role="textbox" aria-label="Composer" style="min-height:20px"></div>
<script>customElements.define('x-card', class extends HTMLElement { constructor() { super();
  this.attachShadow({ mode: 'open' }).innerHTML = '<button>Shadow Save</button><input placeholder="Shadow field">'; } });</script>`;

describe("shadow roots and editable divs", () => {
  it("are in the snapshot, in page order", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(PAGE);
      const rows = (await snapshotPage(page)).split("\n");
      expect(rows).toEqual([
        "button text=Light",
        "button text=Shadow Save",
        "input placeholder=Shadow field",
        "div editable role=textbox aria=Composer",
      ]);
    } finally {
      await browser.close();
    }
  });

  it("are recorded as the element acted on, with what was typed", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const seen: Array<{ kind: string; target: { name: string | null }; value?: string }> = [];
      await page.exposeBinding(BINDING, (_s, a) => {
        seen.push(a);
      });
      await page.addInitScript(OBSERVER_SCRIPT);
      await page.goto(`data:text/html,${encodeURIComponent(PAGE)}`);
      await page.getByRole("button", { name: "Shadow Save" }).click();
      await page.getByPlaceholder("Shadow field").fill("abc");
      await page.getByRole("textbox", { name: "Composer" }).click();
      await page.keyboard.type("hello");
      await page.getByRole("button", { name: "Light" }).click();
      await expect.poll(() => seen.length).toBeGreaterThanOrEqual(5);
      // `fill` focuses without a click; the field's value lands when focus leaves it.
      expect(seen.map((a) => [a.kind, a.target.name, a.value ?? null])).toEqual([
        ["click", "Shadow Save", null],
        ["input", "Shadow field", "abc"],
        ["click", "Composer", null],
        ["input", "Composer", "hello"],
        ["click", "Light", null],
      ]);
    } finally {
      await browser.close();
    }
  });
});
