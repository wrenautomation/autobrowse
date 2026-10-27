import { chromium as patchright } from "patchright";
import type { chromium as Chromium, Page } from "playwright";
import { describe, expect, it } from "vitest";
import { extrasOf } from "../src/browser/extras.js";
import { locate } from "../src/browser/locate.js";
import { marksFor } from "../src/explore/marks.js";

/** What the session runs on: Patchright, whose locators walk closed shadow roots. */
const chromium = patchright as unknown as typeof Chromium;

/** A closed root with a button, a field and a link one root deeper; two cards clickable only by a listener; a plain button. */
const PAGE = `<button>Light</button><div id=h></div>
<div class=card style="cursor:pointer"><span>Acme plan</span><small>$9</small></div>
<div class=card style="cursor:pointer"><span>Acme plan</span><small>$19</small></div>
<label style="cursor:pointer"><input type=checkbox> Remember</label>
<script>for (const c of document.querySelectorAll('.card')) c.addEventListener('click', () => { c.dataset.hit = 1; });
const r = document.getElementById('h').attachShadow({ mode: 'closed' });
r.innerHTML = '<button onclick="this.textContent=\\'Done\\'">Closed Save</button><input aria-label="Closed field"><div id=n></div>';
r.getElementById('n').attachShadow({ mode: 'closed' }).innerHTML = '<a href="#x">Deep link</a>';</script>`;

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(PAGE);
    await run(page);
  } finally {
    await browser.close();
  }
}

describe("extras: what the aria tree leaves out", () => {
  it("finds closed-root controls and outermost pointer cards, not what the tree shows", async () => {
    await withPage(async (page) => {
      const aria = await page.locator("body").ariaSnapshot();
      expect(aria).not.toContain("Closed Save");
      const found = await extrasOf(page);
      expect(found.map((e) => [e.why, e.role, e.name])).toEqual([
        ["closed-shadow", "button", "Closed Save"],
        ["closed-shadow", "textbox", "Closed field"],
        ["closed-shadow", "link", "Deep link"],
        ["pointer", "clickable", "Acme plan$9"],
        ["pointer", "clickable", "Acme plan$19"],
      ]);
      // The tag is gone after: the page keeps no attribute of ours.
      const tagged = await page
        .locator("*")
        .evaluateAll((els) =>
          els.some((e) => e.getAttributeNames().some((n) => n.startsWith("data-x"))),
        );
      expect(tagged).toBe(false);
    });
  });

  it("gives hints that act on the element itself", async () => {
    await withPage(async (page) => {
      const found = await extrasOf(page);
      const save = found.find((e) => e.name === "Closed Save");
      await locate(page, save?.hints ?? {}).click();
      expect(await page.getByRole("button", { name: "Done" }).count()).toBe(1);
      const second = found.filter((e) => e.why === "pointer")[1];
      await locate(page, second?.hints ?? {}).click();
      const hit = await page
        .locator(".card")
        .evaluateAll((els) =>
          els.map((e) => (e as unknown as { dataset: { hit?: string } }).dataset.hit ?? null),
        );
      expect(hit).toEqual([null, "1"]);
    });
  });

  it("marks number a pointer card too, and its mark acts on it", async () => {
    await withPage(async (page) => {
      const marks = marksFor();
      const { marks: taken } = await marks.take(page, async () => "shot.png");
      const cards = taken.filter((m) => m.tag === "div");
      expect(cards).toHaveLength(2);
      await locate(page, await marks.hints(page, (cards[1] as { n: number }).n)).click();
      const hit = await page
        .locator(".card")
        .evaluateAll((els) =>
          els.map((e) => (e as unknown as { dataset: { hit?: string } }).dataset.hit ?? null),
        );
      expect(hit).toEqual([null, "1"]);
    });
  });
});
