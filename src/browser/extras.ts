/**
 * Controls the aria snapshot leaves out but a locator still reaches
 * (designs/2026-10-27-explore-gaps.md): a control inside a closed shadow
 * root, and an element that is only clickable by script (a `cursor:
 * pointer` card, an `onclick` div) with no role. Patchright's `*` locator
 * walks closed roots; the snapshot does not. Each extra carries hints that
 * find it again, checked against the element itself, so a ref on one acts
 * like any other.
 */
import { randomBytes } from "node:crypto";
import type { Page } from "playwright";
import { HINTS_JS } from "../recorder/observer.js";
import { type Hints, locateAll, planLocator } from "./locate.js";

/** More than this and a feed page buries the outline. */
export const MAX_EXTRAS = 20;

export interface Extra {
  /** The control's own role; `clickable` for an element with none. */
  role: string;
  name: string;
  hints: Hints;
  why: "closed-shadow" | "pointer";
}

/** What the tree already shows as a ref: an element like these is never an extra. */
const CONTROL =
  "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=combobox], [role=textbox], [role=searchbox], [role=slider], [role=spinbutton], [role=treeitem], [role=listbox]";

/** Raw finds from the page, before their hints are checked. */
interface Raw {
  k: number;
  why: Extra["why"];
  label: string;
  hints: Hints;
}

/** Over every element (closed roots included): the extras, each tagged `attr`=`k`. */
const findBody = `const { attr, max, control } = arg;
${HINTS_JS}
  const out = [];
  const inClosed = (el) => {
    for (let r = el.getRootNode(); r instanceof ShadowRoot; r = r.host.getRootNode())
      if (r.host.shadowRoot === null) return true;
    return false;
  };
  const up = (el) => el.parentElement || (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);
  const shown = (el) => {
    const b = el.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const underControl = (el) => {
    for (let p = up(el); p; p = up(p)) if (p.matches(control)) return true;
    return false;
  };
  const line = (el) => ((el.innerText || el.textContent || '').split('\\n').map((s) => s.trim()).find(Boolean) || '').slice(0, 60);
  for (const el of els) {
    if (el.hasAttribute(attr)) el.removeAttribute(attr);
    if (out.length >= max) continue;
    let why = null;
    if (el.matches(control)) {
      if (inClosed(el) && shown(el)) why = 'closed-shadow';
    } else if (!['HTML', 'BODY', 'LABEL'].includes(el.tagName) && !el.querySelector(control)) {
      // A label or a card around a real control: the tree already gives that control a ref.
      const handler = el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.tabIndex >= 0);
      // cursor is inherited: only the outermost element that sets it is the control.
      const p = up(el);
      const pointer = getComputedStyle(el).cursor === 'pointer' && !(p && getComputedStyle(p).cursor === 'pointer');
      if ((handler || pointer) && !underControl(el) && shown(el)) why = 'pointer';
    }
    if (!why) continue;
    const h = hints(el);
    const label = (why === 'closed-shadow' && h.name) || trim(el.getAttribute('aria-label')) || trim(el.getAttribute('title')) || line(el);
    if (!label) continue;
    el.setAttribute(attr, String(out.length));
    out.push({ k: out.length, why, label, hints: h });
  }
  return out;`;
/** A real function, so Playwright sends its source into the page. */
const findScript = new Function("els", "arg", findBody) as (els: unknown[], arg: unknown) => Raw[];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Hints to try for one find, best first: its own, then its first line of
 * text, then its tag. The first whose matches hold the element (or a part
 * of it: a text match is the innermost) wins, with `nth` its place.
 */
function tries(r: Raw): Hints[] {
  const { nth: _, ...own } = r.hints;
  const out: Hints[] = [own];
  if (r.why === "pointer") out.push({ text: `/^\\s*${escapeRe(r.label)}/` });
  if (own.tag) out.push({ tag: own.tag, css: own.tag });
  return out;
}

/** The page's extras, top-level document and its shadow roots; iframes are not searched. */
export async function extrasOf(page: Page, max = MAX_EXTRAS): Promise<Extra[]> {
  const attr = `data-x${randomBytes(4).toString("hex")}`;
  const raw = await page
    .locator("*")
    .evaluateAll(findScript, { attr, max, control: CONTROL })
    .catch(() => [] as Raw[]);
  const out: Extra[] = [];
  try {
    for (const r of raw) {
      for (const t of tries(r)) {
        if (!planLocator(t)) continue;
        const i = await locateAll(page, t)
          .evaluateAll(
            (els, m) => els.findIndex((e) => e.closest(`[${m.attr}="${m.k}"]`) !== null),
            { attr, k: String(r.k) },
          )
          .catch(() => -1);
        if (i < 0) continue;
        out.push({
          role: r.why === "pointer" ? "clickable" : (r.hints.role ?? r.hints.tag ?? "generic"),
          name: r.label,
          hints: i ? { ...t, nth: i } : t,
          why: r.why,
        });
        break;
      }
    }
  } finally {
    await page
      .locator(`[${attr}]`)
      .evaluateAll((els, a) => {
        for (const e of els) e.removeAttribute(a);
      }, attr)
      .catch(() => undefined);
  }
  return out;
}
