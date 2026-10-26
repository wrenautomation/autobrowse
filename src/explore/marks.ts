/**
 * Set-of-marks: a numbered box on each control in view, for a target that hints and the aria
 * tree miss (designs/2026-10-25-explore-marks.md). A mark resolves to the control's locator
 * hints and its place among their matches, so the journal and a compiled flow replay it
 * without the picture. Never a press at a point. Controls in iframes are marked too; their
 * hints carry the frame chain.
 */
import { randomBytes } from "node:crypto";
import type { Frame, Page } from "playwright";
import { framesInView } from "../browser/frames.js";
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

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A control one frame's script found: `k` its place in that frame, the box in that frame. */
interface Raw {
  k: number;
  box: Box;
  hints: Hints;
}

/** A control on the picture: the box in the page's viewport, the hints with any frame chain. */
interface Found {
  n: number;
  box: Box;
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

/** In one frame: each control in its view, top to bottom, tagged `attr`=`t<k>` until numbered. */
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
  return seen.slice(0, ${max}).map(({ el, r }, k) => {
    el.setAttribute(ATTR, 't' + k);
    return { k, box: { x: r.left, y: r.top, w: r.width, h: r.height }, hints: hints(el) };
  });
})()`;

/** In one frame: `t<k>` becomes the mark's number; a control past the cap loses its tag. */
const numberScript = (attr: string, numbers: Record<number, number>) => `(() => {
  const ATTR = ${JSON.stringify(attr)};
  const numbers = ${JSON.stringify(numbers)};
  const roots = [document];
  while (roots.length) {
    const root = roots.shift();
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
      const v = el.getAttribute(ATTR);
      if (!v || v[0] !== 't') continue;
      const n = numbers[v.slice(1)];
      if (n) el.setAttribute(ATTR, String(n));
      else el.removeAttribute(ATTR);
    }
  }
})()`;

/** In the page: of these points, the ones where the top element is a frame (no dialog over it). */
const framesOnTop = (points: Array<[number, number]>) => `(() =>
  ${JSON.stringify(points)}.map(([x, y]) => {
    const top = document.elementFromPoint(x, y);
    return !!top && (top.tagName === 'IFRAME' || top.tagName === 'FRAME');
  }))()`;

/** Where a frame's viewport starts in the page's: its element's box plus its border. */
async function offsetOf(frame: Frame): Promise<{ x: number; y: number } | null> {
  const el = await frame.frameElement().catch(() => null);
  if (!el) return null;
  try {
    const box = await el.boundingBox();
    if (!box) return null;
    // No DOM lib in this build: the frame element's border widths, read in the page.
    const edge = await el.evaluate((e) => {
      const { clientLeft: l, clientTop: t } = e as unknown as {
        clientLeft: number;
        clientTop: number;
      };
      return { l, t };
    });
    return { x: box.x + edge.l, y: box.y + edge.t };
  } catch {
    return null;
  } finally {
    await el.dispose().catch(() => undefined);
  }
}

/** Every control in view, in the page and its visible frames, numbered top to bottom. */
async function findAll(page: Page, attr: string): Promise<Found[]> {
  const frames: Array<{ frame: Frame; chain: string | null; at: { x: number; y: number } }> = [
    { frame: page.mainFrame(), chain: null, at: { x: 0, y: 0 } },
  ];
  for (const { frame, chain } of await framesInView(page)) {
    const at = await offsetOf(frame);
    if (at) frames.push({ frame, chain, at });
  }
  const view = page.viewportSize() ?? {
    width: Number.POSITIVE_INFINITY,
    height: Number.POSITIVE_INFINITY,
  };
  const all: Array<Omit<Found, "n"> & { f: number; k: number }> = [];
  for (const [f, { frame, chain, at }] of frames.entries()) {
    // A frame that went away between the list and the read has no marks.
    const raw = await frame.evaluate<Raw[]>(findScript(attr, MAX_MARKS)).catch(() => [] as Raw[]);
    const inView = raw
      .map(({ k, box, hints: h }) => ({
        f,
        k,
        box: { ...box, x: box.x + at.x, y: box.y + at.y },
        hints: chain ? { ...h, frame: chain } : h,
      }))
      .filter(
        ({ box }) =>
          box.x + box.w > 0 && box.y + box.h > 0 && box.x < view.width && box.y < view.height,
      );
    if (!chain || !inView.length) {
      all.push(...inView);
      continue;
    }
    // A dialog in the page over the frame hides its controls.
    const onTop = await page
      .evaluate<boolean[]>(
        framesOnTop(
          inView.map(({ box }) => [
            Math.min(Math.max(box.x + box.w / 2, 0), view.width - 1),
            Math.min(Math.max(box.y + box.h / 2, 0), view.height - 1),
          ]),
        ),
      )
      .catch(() => inView.map(() => false));
    all.push(...inView.filter((_, i) => onTop[i]));
  }
  all.sort((a, b) => Math.round(a.box.y / 8) - Math.round(b.box.y / 8) || a.box.x - b.box.x);
  const kept = all.slice(0, MAX_MARKS).map((m, i) => ({ ...m, n: i + 1 }));
  for (const [f, { frame }] of frames.entries()) {
    const numbers = Object.fromEntries(kept.filter((m) => m.f === f).map((m) => [m.k, m.n]));
    await frame.evaluate(numberScript(attr, numbers)).catch(() => undefined);
  }
  return kept.map(({ n, box, hints: h }) => ({ n, box, hints: h }));
}

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
      const found = await findAll(page, attr);
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
      const root = h.frame ? page.frameLocator(h.frame) : page;
      if (!(await root.locator(`[${attr}="${n}"]`).count()))
        throw new StaleMark(`mark ${n} is stale (the page changed): take marks again`);
      const { nth: _, ...own } = h;
      const tries: Hints[] = [own];
      const frame = own.frame ? { frame: own.frame } : {};
      if (own.role) tries.push({ tag: own.tag, role: own.role, ...frame });
      if (own.tag) tries.push({ tag: own.tag, css: own.tag, ...frame });
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
