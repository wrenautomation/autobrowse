/**
 * The headed overlay (designs/2026-10-27-explore-gaps.md): what the agent
 * sees and why it acts, drawn over the page for a person who watches. Boxes
 * carry the outline's ref numbers; the control about to be acted on flashes;
 * a terminal-style panel holds the goal, the thought, the act and a live
 * trace of every command. It sits in a closed shadow root outside `body` (so
 * the aria tree never reads it) and is taken off for every screenshot.
 * Headless, nothing is drawn.
 *
 * The panel takes clicks (fold, move, open a trace row) without the page
 * knowing: a window capture listener swallows every pointer event over it
 * before the page's handlers or the recorder's observer see one, and
 * mousedown's default is stopped so focus stays where it was. While a
 * command runs the panel is inert (pointer-events none): no act can land on it.
 */
import { randomBytes } from "node:crypto";
import type { Page } from "playwright";
import { type Hints, locate } from "../browser/locate.js";
import type { Command } from "./commands.js";
import type { Box } from "./marks.js";

/** One command as the trace shows it; never a typed value. */
export interface TraceRow {
  n: number;
  /** HH:MM:SS, local. */
  at: string;
  cmd: string;
  what: string;
  ok: boolean;
  ms: number;
  /** Shown when the row is opened: target, url, error. */
  detail: string[];
}

/** What the panel and boxes show; null leaves a part off. */
export interface OverlayState {
  goal: string | null;
  step: string | null;
  thought: string | null;
  /** The act under way: `click: open the pricing page`. */
  doing: string | null;
  boxes: Array<{ n: number; box: Box }>;
  target: Box | null;
  /** A command is running: the panel takes no pointer. */
  busy: boolean;
  trace: TraceRow[];
}

const EMPTY: OverlayState = {
  goal: null,
  step: null,
  thought: null,
  doing: null,
  boxes: [],
  target: null,
  busy: false,
  trace: [],
};

/** A ref's box resolves this fast or is left off: a slow find never holds up a step. */
const BOX_MS = 400;
/** A draw never holds a command longer than this. */
const DRAW_MS = 1_000;
/** Rows kept; the panel scrolls them. */
const TRACE_KEEP = 200;

/** Wren dark tokens (wren/designs/2026-10-20-design-language). */
const T = {
  canvas: "#0d0d0c",
  paper: "#171716",
  ink: "#f2f0ea",
  ink2: "#a9a79f",
  ink3: "#8f8d86",
  accent: "#a596d6",
  onAccent: "#15121f",
  good: "#4cc27a",
  bad: "#ff6b5e",
};

/** How a person left the panel: carried into each new document. */
interface Prefs {
  min: boolean;
  trace: boolean;
  right: boolean;
  hidden: boolean;
}

/** In the page: the layer drawn from `s`, or taken away when `s` is undefined. */
const layerScript = (attr: string, s: OverlayState | undefined, prefs: Prefs) => `(() => {
  const K = '__${attr}';
  const ui = window[K] || (window[K] = { ...${JSON.stringify(prefs)}, open: null, scroll: 0 });
  const prefs = () => ({ min: ui.min, trace: ui.trace, right: ui.right, hidden: ui.hidden });
  for (const old of document.querySelectorAll('[${attr}]')) old.remove();
  ui.host = null;
  const s = ${JSON.stringify(s ?? null)};
  if (!s) return prefs();
  ui.s = s;
  if (!ui.bound) {
    ui.bound = true;
    // Capture on window runs before the page's document listeners and the observer.
    const KINDS = ['pointerdown','pointerup','pointermove','pointerover','pointerout','pointerenter','pointerleave',
      'mousedown','mouseup','mousemove','mouseover','mouseout','mouseenter','mouseleave',
      'click','dblclick','auxclick','contextmenu','wheel','touchstart','touchend','touchmove'];
    for (const k of KINDS) window.addEventListener(k, (e) => {
      if (!ui.host || e.target !== ui.host) return;
      e.stopImmediatePropagation();
      // mousedown's default moves focus.
      if (k === 'mousedown' || k === 'click' || k === 'auxclick' || k === 'contextmenu' || k === 'dblclick') e.preventDefault();
      const hit = ui.root && ui.root.elementFromPoint(e.clientX, e.clientY);
      // A wheel scrolls the trace list, never the page under the panel.
      if (k === 'wheel' && !(hit && hit.closest('.rows'))) e.preventDefault();
      if (k !== 'click') return;
      const a = hit && hit.closest('[data-a]');
      if (!a) return;
      const act = a.getAttribute('data-a');
      if (act === 'min') ui.min = !ui.min;
      else if (act === 'hide') ui.hidden = !ui.hidden;
      else if (act === 'move') ui.right = !ui.right;
      else if (act === 'trace') ui.trace = !ui.trace;
      else if (act.startsWith('row:')) { const n = Number(act.slice(4)); ui.open = ui.open === n ? null : n; }
      ui.draw(ui.s);
    }, { capture: true, passive: false });
  }
  ui.draw = (s) => {
    const list = ui.root && ui.root.querySelector('.rows');
    if (list) ui.scroll = list.scrollTop;
    for (const old of document.querySelectorAll('[${attr}]')) old.remove();
    const host = document.createElement('div');
    host.setAttribute('${attr}', '');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    const root = host.attachShadow({ mode: 'closed' });
    const el = (tag, cls, text, css) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; if (css) e.style.cssText = css; return e; };
    const at = (b) => 'left:' + b.x + 'px;top:' + b.y + 'px;width:' + b.w + 'px;height:' + b.h + 'px;';
    const style = document.createElement('style');
    style.textContent = [
      '*{box-sizing:border-box}',
      '.box{position:fixed;border:1.5px dashed;border-radius:2px}',
      '.tag{position:absolute;left:-1.5px;font:700 10px/13px ui-monospace,Menlo,monospace;color:${T.onAccent};background:${T.accent};padding:0 4px}',
      '.target{position:fixed;border:2px solid ${T.accent};animation:pulse .9s ease-out infinite}',
      '@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(165,150,214,.75)}100%{box-shadow:0 0 0 12px rgba(165,150,214,0)}}',
      '.tui{position:fixed;bottom:12px;width:440px;max-width:calc(100vw - 24px);pointer-events:auto;cursor:default;user-select:none;',
      'font:12px/1.5 "JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace;color:${T.ink};',
      'background:${T.canvas} repeating-linear-gradient(0deg,rgba(255,255,255,.028) 0 1px,transparent 1px 3px);',
      'border:1px solid ${T.accent};box-shadow:0 0 0 1px #000,0 10px 32px rgba(0,0,0,.55),0 0 22px rgba(165,150,214,.14);',
      'text-shadow:0 0 6px rgba(165,150,214,.22)}',
      '.tui.busy,.chip.busy{pointer-events:none}',
      '.chip{position:fixed;bottom:12px;pointer-events:auto;cursor:pointer;user-select:none;padding:0 8px;font:700 11px/22px "JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace;color:${T.accent};background:${T.canvas};border:1px solid ${T.accent};box-shadow:0 4px 14px rgba(0,0,0,.4)}',
      '.chip:hover{color:${T.onAccent};background:${T.accent}}',
      '.chip .run{animation:blink 1s steps(2) infinite}',
      '.bar{display:flex;align-items:center;gap:8px;padding:2px 8px;background:${T.paper};border-bottom:1px solid ${T.accent}}',
      '.bar .name{font-weight:700;color:${T.accent};letter-spacing:.04em}',
      '.bar .state{color:${T.ink3}}',
      '.bar .state.run{color:${T.accent};animation:blink 1s steps(2) infinite}',
      '.bar .fill{flex:1}',
      '.btn{color:${T.ink3};cursor:pointer;padding:0 2px}',
      '.btn:hover{color:${T.onAccent};background:${T.accent};text-shadow:none}',
      '.body{padding:6px 10px 8px}',
      '.k{color:${T.ink3}}',
      '.goal{color:${T.ink};font-weight:700}',
      '.thought{color:${T.ink2}}',
      '.doing{color:${T.accent}}',
      '.cursor{display:inline-block;width:.6em;height:1.05em;margin-left:2px;vertical-align:-2px;background:${T.accent};animation:blink 1s steps(2) infinite}',
      '@keyframes blink{50%{opacity:0}}',
      '.rule{display:flex;gap:6px;color:${T.ink3};padding:0 8px;border-top:1px solid ${T.paper};margin-top:2px}',
      '.rule .t{color:${T.ink3}}',
      '.rows{max-height:200px;overflow-y:auto;padding:2px 0 4px;scrollbar-width:thin;scrollbar-color:${T.accent} transparent}',
      '.row{display:grid;grid-template-columns:3ch 8ch 7ch 1fr 1.5ch 6ch;gap:6px;padding:0 8px;cursor:pointer}',
      '.row:hover{background:${T.paper}}',
      '.row.new{animation:fresh 1.2s ease-out}',
      '@keyframes fresh{from{background:rgba(165,150,214,.28)}to{background:transparent}}',
      '.row .n,.row .at,.row .ms{color:${T.ink3}}',
      '.row .ms{text-align:right}',
      '.row .cmd{color:${T.accent}}',
      '.row .what{color:${T.ink};overflow-wrap:anywhere}',
      '.ok{color:${T.good}}.no{color:${T.bad}}',
      '.detail{padding:0 8px 4px 23ch;color:${T.ink2};white-space:pre-wrap;overflow-wrap:anywhere}',
      '.detail .no{color:${T.bad}}',
    ].join('');
    root.appendChild(style);
    for (const { n, box } of s.boxes) {
      const b = el('div', 'box', null, at(box) + 'border-color:${T.accent}');
      b.appendChild(el('div', 'tag', String(n), box.y < 14 ? 'top:0' : 'top:-14px'));
      root.appendChild(b);
    }
    if (s.target) root.appendChild(el('div', 'target', null, at(s.target)));
    const side = ui.right ? 'right:12px' : 'left:12px';
    if (ui.hidden) {
      // Folded away: one small chip, the page free around it.
      const chip = el('div', 'chip' + (s.busy ? ' busy' : ''), '▌ab ', side);
      chip.appendChild(el('span', s.busy ? 'run' : '', s.busy ? '●' : '○'));
      chip.setAttribute('data-a', 'hide');
      root.appendChild(chip);
      document.documentElement.appendChild(host);
      ui.host = host;
      ui.root = root;
      return;
    }
    const tui = el('div', 'tui' + (s.busy ? ' busy' : ''), null, side);
    const bar = el('div', 'bar');
    bar.appendChild(el('span', 'name', '▌autobrowse'));
    bar.appendChild(el('span', 'state' + (s.busy ? ' run' : ''), s.busy ? '● run' : '○ idle'));
    if (s.step) bar.appendChild(el('span', 'k', 'step ' + s.step));
    bar.appendChild(el('span', 'fill'));
    const btn = (a, t) => { const b = el('span', 'btn', t); b.setAttribute('data-a', a); return b; };
    bar.appendChild(btn('move', ui.right ? '[⇤]' : '[⇥]'));
    bar.appendChild(btn('min', ui.min ? '[+]' : '[_]'));
    bar.appendChild(btn('hide', '[×]'));
    tui.appendChild(bar);
    if (!ui.min) {
      const body = el('div', 'body');
      const line = (k, cls, t) => { const d = el('div'); d.appendChild(el('span', 'k', k)); d.appendChild(el('span', cls, t)); return d; };
      if (s.goal) body.appendChild(line('goal ', 'goal', s.goal));
      if (s.thought) body.appendChild(line('» ', 'thought', s.thought));
      const d = line('$ ', 'doing', s.doing || (s.busy ? '' : 'waiting for the agent'));
      if (s.busy || !s.doing) d.appendChild(el('span', 'cursor'));
      body.appendChild(d);
      tui.appendChild(body);
      const rule = el('div', 'rule');
      rule.appendChild(el('span', 't', '─ trace'));
      rule.appendChild(el('span', 't', String(s.trace.length)));
      rule.appendChild(el('span', 'fill', null, 'flex:1'));
      rule.appendChild(btn('trace', ui.trace ? '[▾]' : '[▸]'));
      tui.appendChild(rule);
      if (ui.trace && s.trace.length) {
        const rows = el('div', 'rows');
        const newest = s.trace[s.trace.length - 1].n;
        for (const r of s.trace.slice().reverse()) {
          const row = el('div', 'row' + (r.n === newest && ui.seen !== newest ? ' new' : ''));
          row.setAttribute('data-a', 'row:' + r.n);
          row.appendChild(el('span', 'n', String(r.n)));
          row.appendChild(el('span', 'at', r.at));
          row.appendChild(el('span', 'cmd', r.cmd));
          row.appendChild(el('span', 'what', r.what));
          row.appendChild(el('span', r.ok ? 'ok' : 'no', r.ok ? '✓' : '✗'));
          row.appendChild(el('span', 'ms', r.ms < 1000 ? r.ms + 'ms' : (r.ms / 1000).toFixed(1) + 's'));
          rows.appendChild(row);
          if (ui.open === r.n && r.detail.length) {
            const det = el('div', 'detail');
            for (const t of r.detail) det.appendChild(el('div', t.startsWith('error') ? 'no' : '', t));
            det.setAttribute('data-a', 'row:' + r.n);
            rows.appendChild(det);
          }
        }
        ui.seen = newest;
        tui.appendChild(rows);
        rows.scrollTop = ui.scroll;
      }
    }
    root.appendChild(tui);
    document.documentElement.appendChild(host);
    ui.host = host;
    ui.root = root;
  };
  ui.draw(s);
  return prefs();
})()`;

const clipLine = (s: string | null | undefined, n: number) =>
  s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null;

/** One session's overlay; `enabled` false makes every call a no-op. */
export function overlayFor(enabled: boolean) {
  // A random attribute name: the page sees a node, never one that names us.
  const attr = `data-o${randomBytes(4).toString("hex")}`;
  let state: OverlayState = { ...EMPTY };
  let drawn = false;
  let prefs: Prefs = { min: false, trace: true, right: false, hidden: false };
  const paint = async (page: Page, s: OverlayState | undefined) => {
    const got = await Promise.race([
      page.evaluate(layerScript(attr, s, prefs)).catch(() => undefined),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), DRAW_MS).unref()),
    ]);
    if (got && typeof got === "object") prefs = got as Prefs;
  };
  const draw = async (page: Page) => {
    if (!enabled) return;
    await paint(page, state);
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
      if (clear) state = { ...EMPTY, trace: state.trace, busy: state.busy };
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
    /** A command starts: the panel goes inert before the act can reach the page. */
    async begin(page: Page): Promise<void> {
      if (!enabled) return;
      state.busy = true;
      if (drawn) await draw(page);
    },
    /** A command ended: its row joins the trace and the panel takes clicks again. */
    async end(page: Page, row: Omit<TraceRow, "n" | "at">): Promise<void> {
      if (!enabled) return;
      const n = (state.trace.at(-1)?.n ?? 0) + 1;
      const at = new Date().toTimeString().slice(0, 8);
      state.trace = [...state.trace, { ...row, n, at }].slice(-TRACE_KEEP);
      state.busy = false;
      // The row holds the act now; the line waits for the next.
      state.doing = null;
      await draw(page);
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
      await paint(page, undefined);
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
      await paint(page, undefined);
    },
  };
}

export type Overlay = ReturnType<typeof overlayFor>;

const hintLabel = (h: Record<string, unknown>): string => {
  const said = h.name ?? h.text ?? h.placeholder ?? h.id ?? h.testId ?? h.href ?? h.css;
  return [h.role, said === undefined ? null : `"${String(said)}"`, h.mark ? `mark ${h.mark}` : null]
    .filter(Boolean)
    .join(" ");
};

/** Host and path: a query string may carry a token. */
const shortUrl = (u: string): string => {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}`;
  } catch {
    return u;
  }
};

/** A command as one trace row: what it aimed at, never a typed value. */
export function traceRow(c: Command, failed: unknown, ms: number): Omit<TraceRow, "n" | "at"> {
  const f = c as unknown as Record<string, unknown>;
  const hints = (f.hints ?? null) as Record<string, unknown> | null;
  const aim =
    c.cmd === "open"
      ? shortUrl(String(f.url))
      : c.cmd === "place"
        ? `${String(f.secret)} → ${hints ? hintLabel(hints) : "focus"}`
        : c.cmd === "type"
          ? `${String(f.text ?? "").length} chars`
          : c.cmd === "key" || c.cmd === "press"
            ? String(f.key)
            : c.cmd === "batch"
              ? `${(f.cmds as unknown[]).length} commands`
              : c.cmd === "os"
                ? String((f.act as { kind?: string }).kind)
                : String(
                    f.as ?? f["env"] ?? f.name ?? f.outcome ?? (hints ? hintLabel(hints) : ""),
                  );
  const what = typeof f.goal === "string" && f.goal ? `${f.goal} · ${aim}` : aim;
  const detail = [
    ...(hints ? [`target ${JSON.stringify(hints)}`] : []),
    ...(failed
      ? [`error ${clipLine(failed instanceof Error ? failed.message : String(failed), 400)}`]
      : []),
  ];
  return { cmd: c.cmd, what: clipLine(what, 200) ?? "", ok: !failed, ms: Math.round(ms), detail };
}
