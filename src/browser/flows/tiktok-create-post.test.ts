import { type Browser, chromium, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FlowPage } from "../flow.js";
import { instantHands } from "../human/index.js";
import { type Hints, locate } from "../locate.js";
import {
  folded,
  handleOf,
  setToggle,
  TOGGLES,
  type Toggle,
  videoIdsOf,
} from "./tiktok-create-post.js";

describe("tiktok create-post read back", () => {
  it("takes video ids from links, deduped, in page order", () => {
    expect(
      videoIdsOf([
        "https://www.tiktok.com/@acme/video/7400000000000000002",
        "https://www.tiktok.com/@acme/video/7400000000000000001?is_from_webapp=1",
        "https://www.tiktok.com/@acme/video/7400000000000000002",
        "https://www.tiktok.com/@acme/photo/7400000000000000003",
        "https://www.tiktok.com/tiktokstudio/content",
      ]),
    ).toEqual(["7400000000000000002", "7400000000000000001"]);
  });

  it("reads the handle off the profile URL", () => {
    expect(handleOf("https://www.tiktok.com/@acme.co_1?lang=en")).toBe("acme.co_1");
    expect(handleOf("https://www.tiktok.com/profile")).toBeNull();
  });

  it("compares captions with whitespace folded", () => {
    expect(folded(" Line one\n\nline  two ")).toBe(folded("Line one line two"));
  });
});

/**
 * Studio's settings panel in its real shape (a failed run's trace, 2026-10-14): the whole panel
 * is `hidden` under "Show more"; a checkbox's input is not visible (its label is the control); a
 * switch's input is `aria-hidden` inside `.Switch__content`. Ids are random.
 */
const FORM = (opts: { deadSwitch?: boolean } = {}) => `<!doctype html><body>
<div>HD by default when you post from Web Studio <span id="more">Show more</span></div>
<div hidden class="options-form" id="panel">
  <div data-e2e="user_perm_container"><span>Allow users to:</span>
    <div class="checkbox-container">
      <div class="checkbox"><label for="checkbox-aaa111" aria-checked="true"><div class="wrap" aria-checked="true"><input type="checkbox" id="checkbox-aaa111" class="Checkbox__input" aria-checked="true" checked style="visibility:hidden"><span class="icon"><svg width="12" height="12"></svg></span></div><span class="select-none"><span>Comment</span></span></label></div>
      <div class="checkbox"><label for="checkbox-bbb222" aria-checked="true"><div class="wrap" aria-checked="true"><input type="checkbox" id="checkbox-bbb222" class="Checkbox__input" aria-checked="true" checked style="visibility:hidden"><span class="icon"><svg width="12" height="12"></svg></span></div><span class="select-none"><div><span>Reuse of content</span></div></span></label></div>
    </div>
  </div>
  <div data-e2e="aigc_container"><span>AI-generated content</span>
    <div class="Tooltip__root"><div class="switch"><div class="Switch__root"><div class="Switch__content" aria-checked="false" style="display:inline-block;width:40px;height:20px;position:relative"><span class="Switch__thumb"></span><input role="switch" type="checkbox" aria-hidden="true" id=":r6m:" class="Switch__input" style="appearance:none;position:absolute;inset:0;opacity:0;${opts.deadSwitch ? "pointer-events:none" : ""}"></div></div></div></div>
  </div>
</div>
<script>(() => {
  const sync = (i) => {
    for (const e of [i, i.closest('label'), i.closest('.wrap'), i.closest('.Switch__content')])
      if (e && e.hasAttribute('aria-checked')) e.setAttribute('aria-checked', String(i.checked));
  };
  document.querySelectorAll('input').forEach((i) => i.addEventListener('change', () => sync(i)));
  document.getElementById('more').addEventListener('click', (e) => {
    const p = document.getElementById('panel');
    p.hidden = !p.hidden;
    e.target.textContent = p.hidden ? 'Show more' : 'Show less';
    window.moreClicks = (window.moreClicks || 0) + 1;
  });
})();</script></body>`;

/** A FlowPage over a real page: acts through the repo's locator hints, as the runner does. */
function flowOn(page: Page): FlowPage {
  const fp: Pick<FlowPage, "page" | "has" | "wait" | "act"> = {
    page,
    has: async (h: Hints) => locate(page, h).isVisible(),
    wait: async (ms: number) => void (await page.waitForTimeout(ms)),
    act: async (op: { kind: string }, h: Hints) => {
      if (op.kind !== "click") throw new Error(`fixture: ${op.kind}`);
      await instantHands.click(locate(page, h), { timeout: 2_000 });
    },
  } as never;
  return fp as FlowPage;
}

describe("tiktok create-post toggles on Studio's markup", () => {
  let browser: Browser;
  let page: Page;
  const state = (label: string) =>
    page.evaluate(TOGGLES).then((r) => (r as Toggle[]).find((t) => t.label === label));
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => browser.close());
  beforeEach(async () => {
    page = await browser.newPage();
    await page.setContent(FORM());
  });
  afterEach(async () => page.close());

  it("reads each toggle by its label, with state and whether it shows", async () => {
    expect(await state("Comment")).toMatchObject({ checked: true, shown: false });
    expect(await state("Reuse of content")).toMatchObject({ checked: true, shown: false });
    expect(await state("AI-generated content")).toMatchObject({ checked: false, shown: false });
  });

  it("turns Reuse of content off from the collapsed panel, leaving Comment on", async () => {
    expect(await setToggle(flowOn(page), "Reuse of content", false)).toBeNull();
    expect(await state("Reuse of content")).toMatchObject({ checked: false, shown: true });
    expect(await state("Comment")).toMatchObject({ checked: true });
  });

  it("turns it back on, and a switch on", async () => {
    const fp = flowOn(page);
    expect(await setToggle(fp, "Reuse of content", false)).toBeNull();
    expect(await setToggle(fp, "Reuse of content", true)).toBeNull();
    expect(await setToggle(fp, "AI-generated content", true)).toBeNull();
    expect(await state("Reuse of content")).toMatchObject({ checked: true });
    expect(await state("AI-generated content")).toMatchObject({ checked: true });
    // The panel was opened once, not toggled shut again.
    expect(await page.evaluate("window.moreClicks")).toBe(1);
  });

  it("leaves a toggle that is already right alone, panel and all", async () => {
    const fp = flowOn(page);
    expect(await setToggle(fp, "Comment", true)).toBeNull();
    expect(await setToggle(fp, "AI-generated content", false)).toBeNull();
    expect(await page.evaluate("window.moreClicks")).toBeUndefined();
    expect(await page.locator("#panel").isHidden()).toBe(true);
  });

  it("says so when the form has no such toggle", async () => {
    expect(await setToggle(flowOn(page), "Duet", false)).toBe('no "Duet" on the form');
  });

  it("falls back to the input's own click when the switch body does not take it", async () => {
    await page.setContent(FORM({ deadSwitch: true }));
    expect(await setToggle(flowOn(page), "AI-generated content", true)).toBeNull();
  });
});
