/**
 * Set-of-marks: a numbered box on each control in view, for a target that hints and the aria
 * tree miss (designs/2026-10-25-explore-marks.md). A mark resolves to the control's locator
 * hints and its place among their matches, so the journal and a compiled flow replay it
 * without the picture. Never a press at a point.
 */
import { randomBytes } from "node:crypto";
import type { Page } from "playwright";
import { type Hints, locateAll, planLocator } from "../browser/locate.js";
import { HINTS_JS } from "../recorder/observer.js";

/** More boxes than this and the numbers cover the page. */
export const MAX_MARKS = 150;

export interface Mark {
  n: number;
  tag: string;
  role: string | null;
  name: string | null;
}

interface Found {
  n: number;
  box: { x: number; y: number; w: number; h: number };
  hints: Hints;
}

/** A mark the page no longer carries (a load, a re-render), or one never taken. */
export class StaleMark extends Error {}

/** What a failed find answers with: a miss, an ambiguous match or a stale mark. */
export const missed = (err: unknown): boolean =>
  err instanceof StaleMark ||
  (err instanceof Error &&
    (err.name === "TimeoutError" ||
      /strict mode violation|resolved to 0 elements|no usable locator hints/.test(err.message)));

/** In the page: each control in view, top to bottom, tagged `attr`=n, with its hints. */
const findScript = (attr: string, max: number) => `(() => {
${HINTS_JS}
  const ATTR = ${JSON.stringify(attr)};
  const SEL = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [contenteditable=""], [contenteditable=true], [onclick], [tabindex]:not([tabindex="-1"]), [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem], [role=option], [role=combobox], [role=textbox], [role=searchbox], [role=slider]';
  // A control inside one of these is the same press (a span in a button).
  const LEAF = 'a, button, summary, label, [role=button], [role=link], [role=option], [role=menuitem], [role=tab]';
  const roots = [document];
  const all = [];
  while (roots.length) {
    const root = roots.shift();
    for (const el of root.querySelectorAll('*')) {
      if (el.hasAttribute(ATTR)) el.removeAttribute(ATTR);
      if (el.shadowRoot) roots.push(el.shadowRoot);
      if (el.matches(SEL)) all.push(el);
    }
  }
  const W = innerWidth, H = innerHeight;
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.right <= 0 || r.top >= H || r.left >= W) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return null;
    const x = Math.min(Math.max(r.left + r.width / 2, 0), W - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 0), H - 1);
    let top = el.getRootNode().elementFromPoint ? el.getRootNode().elementFromPoint(x, y) : document.elementFromPoint(x, y);
    // A styled checkbox hides its input under its label.
    const label = top && top.closest && top.closest('label');
    if (!top || !(top === el || el.contains(top) || (label && label.control === el))) return null;
    return r;
  };
  const seen = [];
  for (const el of all) {
    const r = shown(el);
    if (!r) continue;
    const up = el.parentElement && el.parentElement.closest(LEAF);
    if (up && seen.some((s) => s.el === up)) continue;
    seen.push({ el, r });
  }
  seen.sort((a, b) => Math.round(a.r.top / 8) - Math.round(b.r.top / 8) || a.r.left - b.r.left);
  return seen.slice(0, ${max}).map(({ el, r }, i) => {
    el.setAttribute(ATTR, String(i + 1));
    return { n: i + 1, box: { x: r.left, y: r.top, w: r.width, h: r.height }, hints: hints(el) };
  });
})()`;

const COLOURS = ["#e5484d", "#0090ff", "#30a46c", "#f76b15", "#8e4ec6", "#d6409f"];

/** In the page: the numbered boxes, in a layer no press reaches; `undefined` takes it away. */
const layerScript = (attr: string, found: Found[] | undefined) => `(() => {
  const NAME = ${JSON.stringify(`${attr}-layer`)};
  for (const old of document.querySelectorAll('[' + NAME + ']')) old.remove();
  const found = ${JSON.stringify(found ?? null)};
  if (!found) return;
  const host = document.createElement('div');
  host.setAttribute(NAME, '');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
  const root = host.attachShadow({ mode: 'closed' });
  const COLOURS = ${JSON.stringify(COLOURS)};
  for (const { n, box } of found) {
    const c = COLOURS[n % COLOURS.length];
    const b = document.createElement('div');
    b.style.cssText = 'position:fixed;box-sizing:border-box;border:2px solid ' + c + ';left:' + box.x + 'px;top:' + box.y + 'px;width:' + box.w + 'px;height:' + box.h + 'px';
    const t = document.createElement('div');
    t.textContent = String(n);
    t.style.cssText = 'position:absolute;left:-2px;' + (box.y < 16 ? 'top:0' : 'top:-16px') + ';background:' + c + ';color:#fff;font:bold 11px/14px monospace;padding:0 3px';
    b.appendChild(t);
    root.appendChild(b);
  }
  document.documentElement.appendChild(host);
})()`;

/**
 * One session's marks: the last picture's controls, and how to act on one of them. The scripts
 * run in Patchright's isolated world: the page shares the DOM, never these functions.
 */
export function marksFor() {
  // A random attribute name: the page sees a tag on its controls, never one that names us.
  const attr = `data-m${randomBytes(4).toString("hex")}`;
  let taken = new Map<number, Hints>();
  return {
    /** Numbers the controls in view, shoots the page with the boxes on, takes the boxes away. */
    async take(page: Page, shoot: () => Promise<string>): Promise<{ file: string; marks: Mark[] }> {
      const found = await page.evaluate<Found[]>(findScript(attr, MAX_MARKS));
      taken = new Map(found.map((f) => [f.n, f.hints]));
      await page.evaluate(layerScript(attr, found));
      try {
        return {
          file: await shoot(),
          marks: found.map(({ n, hints: h }) => ({
            n,
            tag: h.tag ?? "",
            role: h.role ?? null,
            name: h.name ?? null,
          })),
        };
      } finally {
        await page.evaluate(layerScript(attr, undefined)).catch(() => undefined);
      }
    },
    /**
     * Mark `n` as hints a flow replays: the control's own, with `nth` its place among their
     * matches. When its name finds nothing (a name the page computes another way), its role,
     * then its tag. Stale when the page no longer carries the mark.
     */
    async hints(page: Page, n: number): Promise<Hints> {
      const h = taken.get(n);
      if (!h) throw new StaleMark(`no mark ${n}: take marks first ({"cmd":"marks"})`);
      if (!(await page.locator(`[${attr}="${n}"]`).count()))
        throw new StaleMark(`mark ${n} is stale (the page changed): take marks again`);
      const { nth: _, ...own } = h;
      const tries: Hints[] = [own];
      if (own.role) tries.push({ tag: own.tag, role: own.role });
      if (own.tag) tries.push({ tag: own.tag, css: own.tag });
      for (const t of tries) {
        if (!planLocator(t)) continue;
        const i = await locateAll(page, t).evaluateAll(
          (els, m) => els.findIndex((e) => e.getAttribute(m.attr) === m.n),
          { attr, n: String(n) },
        );
        if (i >= 0) return i ? { ...t, nth: i } : t;
      }
      throw new StaleMark(`mark ${n}: no locator finds it; take marks again`);
    },
  };
}
