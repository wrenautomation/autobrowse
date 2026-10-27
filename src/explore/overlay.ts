/**
 * The headed overlay (designs/2026-10-27-explore-gaps.md): what the agent
 * sees and why it acts, drawn over the page for a person who watches. Boxes
 * carry the outline's ref numbers; the control about to be acted on flashes;
 * a panel holds the goal, the step, the model's thought and the act. It sits
 * in a closed shadow root no press reaches, outside `body` (so the aria tree
 * never reads it), and is taken off for every screenshot. Headless, nothing
 * is drawn.
 */
import { randomBytes } from "node:crypto";
import type { Page } from "playwright";
import { type Hints, locate } from "../browser/locate.js";
import type { Box } from "./marks.js";

/** What the panel and boxes show; null leaves a part off. */
export interface OverlayState {
  goal: string | null;
  step: string | null;
  thought: string | null;
  /** The act under way: `click: open the pricing page`. */
  doing: string | null;
  boxes: Array<{ n: number; box: Box }>;
  target: Box | null;
}

const EMPTY: OverlayState = {
  goal: null,
  step: null,
  thought: null,
  doing: null,
  boxes: [],
  target: null,
};

/** A ref's box resolves this fast or is left off: a slow find never holds up a step. */
const BOX_MS = 400;

const COLOURS = ["#e5484d", "#0090ff", "#30a46c", "#f76b15", "#8e4ec6", "#d6409f"];

/** In the page: the layer drawn from `s`, or taken away when `s` is undefined. */
const layerScript = (attr: string, s: OverlayState | undefined) => `(() => {
  for (const old of document.querySelectorAll('[${attr}]')) old.remove();
  const s = ${JSON.stringify(s ?? null)};
  if (!s) return;
  const host = document.createElement('div');
  host.setAttribute('${attr}', '');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
  const root = host.attachShadow({ mode: 'closed' });
  const COLOURS = ${JSON.stringify(COLOURS)};
  const el = (tag, css, text) => { const e = document.createElement(tag); e.style.cssText = css; if (text) e.textContent = text; return e; };
  const at = (b) => 'position:fixed;box-sizing:border-box;left:' + b.x + 'px;top:' + b.y + 'px;width:' + b.w + 'px;height:' + b.h + 'px;';
  const style = document.createElement('style');
  style.textContent = '@keyframes ab-pulse{0%{box-shadow:0 0 0 0 rgba(255,196,0,.7)}100%{box-shadow:0 0 0 14px rgba(255,196,0,0)}}';
  root.appendChild(style);
  for (const { n, box } of s.boxes) {
    const c = COLOURS[n % COLOURS.length];
    const b = el('div', at(box) + 'border:1.5px solid ' + c + ';border-radius:3px');
    b.appendChild(el('div', 'position:absolute;left:-1px;' + (box.y < 14 ? 'top:0' : 'top:-14px') + ';background:' + c + ';color:#fff;font:600 10px/14px ui-monospace,monospace;padding:0 3px;border-radius:3px 3px 0 0', String(n)));
    root.appendChild(b);
  }
  if (s.target) root.appendChild(el('div', at(s.target) + 'border:3px solid #ffc400;border-radius:4px;animation:ab-pulse .9s ease-out infinite'));
  const lines = [
    ['autobrowse' + (s.step ? ' · step ' + s.step : ''), 'font:600 11px/16px ui-monospace,monospace;color:#9aa4b2;letter-spacing:.02em'],
    [s.goal, 'font:600 13px/18px system-ui,sans-serif;color:#fff;margin-top:2px'],
    [s.thought, 'font:400 12px/17px system-ui,sans-serif;color:#d7dce3;margin-top:6px'],
    [s.doing, 'font:500 12px/17px ui-monospace,monospace;color:#ffc400;margin-top:6px'],
  ].filter(([t]) => t);
  if (lines.length > 1 || s.step) {
    const panel = el('div', 'position:fixed;left:12px;bottom:12px;max-width:380px;padding:10px 12px;border-radius:10px;background:rgba(17,20,24,.88);box-shadow:0 6px 24px rgba(0,0,0,.35);backdrop-filter:blur(6px)');
    for (const [t, css] of lines) panel.appendChild(el('div', css, t));
    root.appendChild(panel);
  }
  document.documentElement.appendChild(host);
})()`;

const clipLine = (s: string | null | undefined, n: number) =>
  s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null;

/** One session's overlay; `enabled` false makes every call a no-op. */
export function overlayFor(enabled: boolean) {
  // A random attribute name: the page sees a node, never one that names us.
  const attr = `data-o${randomBytes(4).toString("hex")}`;
  let state: OverlayState = { ...EMPTY };
  let drawn = false;
  const draw = async (page: Page) => {
    if (!enabled) return;
    await page.evaluate(layerScript(attr, state)).catch(() => undefined);
    drawn = true;
  };
  const boxOf = async (page: Page, hints: Hints): Promise<Box | null> => {
    const b = await locate(page, hints)
      .boundingBox({ timeout: BOX_MS })
      .catch(() => null);
    if (!b) return null;
    const view = page.viewportSize();
    if (view && (b.x + b.width < 0 || b.y + b.height < 0 || b.x > view.width || b.y > view.height))
      return null;
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  };
  return {
    enabled,
    /** Panel fields from a caller (the agent's goal, step, thought); `refs` boxes the outline's controls. */
    async set(
      page: Page,
      patch: {
        [K in "goal" | "step" | "thought" | "doing"]?: string | null | undefined;
      } & {
        refs?: Array<{ n: number; hints: Hints }> | undefined;
        clear?: boolean | undefined;
      },
    ): Promise<{ drawn: boolean; boxes?: number }> {
      if (!enabled) return { drawn: false };
      const { refs, clear, ...fields } = patch;
      if (clear) state = { ...EMPTY };
      for (const [k, v] of Object.entries(fields))
        if (v !== undefined) (state as unknown as Record<string, unknown>)[k] = clipLine(v, 240);
      if (refs) {
        const boxes = await Promise.all(refs.map((r) => boxOf(page, r.hints)));
        state.boxes = refs.flatMap((r, i) => {
          const box = boxes[i];
          return box ? [{ n: r.n, box }] : [];
        });
      }
      await draw(page);
      return { drawn: true, boxes: state.boxes.length };
    },
    /** Before an act: the target flashes and the panel says what is done. */
    async flash(page: Page, hints: Hints, doing: string): Promise<void> {
      if (!enabled) return;
      state.target = await boxOf(page, hints);
      state.doing = clipLine(doing, 160);
      await draw(page);
    },
    /** After an act: the page may have changed, so its boxes go; the panel stays. */
    async after(page: Page): Promise<void> {
      if (!enabled || !drawn) return;
      state.target = null;
      state.boxes = [];
      await draw(page);
    },
    /** A new document wiped the layer: the panel comes back, without boxes. */
    async loaded(page: Page): Promise<void> {
      if (!drawn) return;
      return this.after(page);
    },
    /** `fn` runs with the layer off: a screenshot shows the page, not us. */
    async around<T>(page: Page, fn: () => Promise<T>): Promise<T> {
      if (!enabled || !drawn) return fn();
      await page.evaluate(layerScript(attr, undefined)).catch(() => undefined);
      try {
        return await fn();
      } finally {
        await draw(page);
      }
    },
    /** The session ends: nothing of ours stays on the page. */
    async remove(page: Page): Promise<void> {
      if (!drawn) return;
      drawn = false;
      state = { ...EMPTY };
      await page.evaluate(layerScript(attr, undefined)).catch(() => undefined);
    },
  };
}

export type Overlay = ReturnType<typeof overlayFor>;
