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
 * The corner grip resizes it; a drag holds pointer capture, so the page never
 * sees the moves.
 */
import { randomBytes } from "node:crypto";
import type { Page } from "playwright";
import { drawsOn } from "../browser/bare.js";
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
  /** One dim line under the row: where the page went, what changed, what was read. */
  note: string;
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
  /** The running command: picks its phase words. */
  cmd: string | null;
  /** The bar's right side: seed, pace. */
  meta: string | null;
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
  cmd: null,
  meta: null,
  trace: [],
};

/** A ref's box resolves this fast or is left off: a slow find never holds up a step. */
const BOX_MS = 400;
/** A draw never holds a command longer than this. */
const DRAW_MS = 1_000;
/** Rows kept; the panel scrolls them. */
const TRACE_KEEP = 200;

/** What the busy line cycles through, in the order the hands do it. */
const PHASES: Record<string, string[]> = {
  click: ["locating", "aiming", "moving", "clicking"],
  fill: ["locating", "focusing", "typing"],
  type: ["typing"],
  place: ["locating", "unsealing", "typing"],
  select: ["locating", "opening", "choosing"],
  upload: ["locating", "attaching"],
  drag: ["locating", "grabbing", "dragging", "dropping"],
  open: ["resolving", "loading", "settling"],
  read: ["locating", "reading"],
  aria: ["walking tree", "outlining"],
  snapshot: ["walking tree", "outlining"],
  marks: ["measuring", "numbering"],
  key: ["pressing"],
  press: ["pressing"],
  download: ["clicking", "receiving"],
  code: ["waiting for code", "typing"],
};
/** Seconds per phase word. */
const PHASE_S = 0.55;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** A CSS `content` cycle: the page runs no timer of ours. */
const contentKeys = (name: string, words: string[]) =>
  `@keyframes ${name}{${[...words, words.at(-1)]
    .map((w, i) => `${Math.round((i / words.length) * 1000) / 10}%{content:${JSON.stringify(w)}}`)
    .join("")}}`;

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
  /** Clicks pass through the panel to the page; only its buttons take them. Default off. */
  through: boolean;
  /** Panel width and trace height, px; `sized` once a person dragged the grip. */
  w: number;
  h: number;
  sized: boolean;
}

/** In the page: the layer drawn from `s`, or taken away when `s` is undefined. */
const layerScript = (attr: string, s: OverlayState | undefined, prefs: Prefs) => `(() => {
  const K = '__${attr}';
  const ui = window[K] || (window[K] = { ...${JSON.stringify(prefs)}, open: null, scroll: 0 });
  const prefs = () => ({ min: ui.min, trace: ui.trace, right: ui.right, hidden: ui.hidden, through: ui.through, w: ui.w, h: ui.h, sized: ui.sized });
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
      'click','dblclick','auxclick','contextmenu','wheel','touchstart','touchend','touchmove','pointercancel'];
    for (const k of KINDS) window.addEventListener(k, (e) => {
      if (!ui.host || e.target !== ui.host) return;
      e.stopImmediatePropagation();
      // The grip: capture keeps every move on us until the button lifts.
      if (k === 'pointerdown' && ui.root) {
        const g = ui.root.elementFromPoint(e.clientX, e.clientY);
        if (g && g.closest('.grip') && ui.tuiEl) {
          ui.drag = { x: e.clientX, y: e.clientY, w: ui.w, h: ui.h };
          ui.tuiEl.setPointerCapture(e.pointerId);
          e.preventDefault();
          return;
        }
      }
      if (ui.drag) {
        if (k === 'pointermove') {
          const dx = (e.clientX - ui.drag.x) * (ui.right ? -1 : 1);
          ui.w = Math.round(Math.max(300, Math.min(innerWidth - 24, ui.drag.w + dx)));
          ui.h = Math.round(Math.max(48, Math.min(innerHeight - 160, ui.drag.h - (e.clientY - ui.drag.y))));
          ui.sized = true;
          ui.tuiEl.style.width = ui.w + 'px';
          const r = ui.root.querySelector('.rows');
          if (r) r.style.height = ui.h + 'px';
        } else if (k === 'pointerup' || k === 'pointercancel') ui.drag = null;
        e.preventDefault();
        return;
      }
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
      else if (act === 'through') ui.through = !ui.through;
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
    // A command's phase words run on from when it began, across redraws.
    if (s.busy && !ui.wasBusy) ui.since = Date.now();
    ui.wasBusy = s.busy;
    const since = ((Date.now() - (ui.since || Date.now())) / 1000).toFixed(2);
    const style = document.createElement('style');
    style.textContent = [
      '*{box-sizing:border-box}',
      '.box{position:fixed;border:1.5px dashed;border-radius:2px}',
      '.tag{position:absolute;left:-1.5px;font:700 10px/13px ui-monospace,Menlo,monospace;color:${T.onAccent};background:${T.accent};padding:0 4px}',
      '.target{position:fixed;border:2px solid ${T.accent};animation:pulse .9s ease-out infinite}',
      '@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(165,150,214,.75)}100%{box-shadow:0 0 0 12px rgba(165,150,214,0)}}',
      '.tui{position:fixed;bottom:12px;max-width:calc(100vw - 24px);pointer-events:auto;cursor:default;user-select:none;',
      'font:12px/1.4 "JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace;color:${T.ink};',
      'background:${T.canvas} repeating-linear-gradient(0deg,rgba(255,255,255,.028) 0 1px,transparent 1px 3px);',
      'border:1px solid ${T.accent};box-shadow:0 0 0 1px #000,0 10px 32px rgba(0,0,0,.55),0 0 22px rgba(165,150,214,.14);',
      'text-shadow:0 0 6px rgba(165,150,214,.22)}',
      '.tui.busy,.chip.busy{pointer-events:none}',
      '.tui.through{pointer-events:none}',
      '.tui.through:not(.busy) :is(.btn,.grip){pointer-events:auto}',
      '.btn.on{color:${T.accent}}',
      '.chip{position:fixed;bottom:12px;pointer-events:auto;cursor:pointer;user-select:none;padding:0 8px;font:700 11px/22px "JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace;color:${T.accent};background:${T.canvas};border:1px solid ${T.accent};box-shadow:0 4px 14px rgba(0,0,0,.4)}',
      '.chip:hover{color:${T.onAccent};background:${T.accent}}',
      '.chip .run{animation:blink 1s steps(2) infinite}',
      '.bar{display:flex;align-items:center;gap:8px;padding:2px 8px;background:${T.paper};border-bottom:1px solid ${T.accent}}',
      '.bar .name{font-weight:700;color:${T.accent};letter-spacing:.04em}',
      '.bar .state{color:${T.ink3}}',
      '.bar .state.run{color:${T.accent};animation:blink 1s steps(2) infinite}',
      '.bar .fill{flex:1}',
      '.bar .meta{color:${T.ink3};font-size:10.5px}',
      '.grip{position:absolute;top:-1px;width:12px;height:12px;cursor:nwse-resize;border-top:2px solid ${T.accent}}',
      '.grip.l{left:-1px;border-left:2px solid ${T.accent};cursor:nwse-resize}',
      '.grip.r{right:-1px;border-right:2px solid ${T.accent};cursor:nesw-resize}',
      '.live{color:${T.ink3}}',
      '.spin::before{content:"${SPIN[0]}";color:${T.accent};animation:spin .8s steps(1) infinite}',
      '.spin.slow::before{animation-duration:1.6s;color:${T.ink3}}',
      '${contentKeys("spin", SPIN)}',
      '.phase::after{content:"";animation:ph var(--d) steps(1) forwards;animation-delay:var(--t)}',
      '.dots::after{content:"";animation:dots 1.8s steps(1) infinite}',
      '${contentKeys("dots", ["", ".", "..", "..."])}',
      '.btn{color:${T.ink3};cursor:pointer;padding:0 2px}',
      '.btn:hover{color:${T.onAccent};background:${T.accent};text-shadow:none}',
      '.body{padding:4px 8px 5px}',
      '.k{color:${T.ink3}}',
      '.goal{color:${T.ink};font-weight:700}',
      '.thought{color:${T.ink2}}',
      '.doing{color:${T.accent}}',
      '.cursor{display:inline-block;width:.6em;height:1.05em;margin-left:2px;vertical-align:-2px;background:${T.accent};animation:blink 1s steps(2) infinite}',
      '@keyframes blink{50%{opacity:0}}',
      '.rule{display:flex;gap:6px;color:${T.ink3};padding:0 8px;border-top:1px solid ${T.paper}}',
      '.rule .t{color:${T.ink3}}',
      '.rows{display:grid;grid-template-columns:auto auto auto minmax(0,1fr) auto auto;column-gap:1ch;align-content:start;overflow-y:auto;padding:1px 0 3px;scrollbar-width:thin;scrollbar-color:${T.accent} transparent}',
      '.row{display:grid;grid-column:1/-1;grid-template-columns:subgrid;padding:0 8px;cursor:pointer}',
      '.row .note{grid-column:4/-1;color:${T.ink3};font-size:11px;line-height:1.3;overflow-wrap:anywhere}',
      '.row .note.no{color:${T.bad};opacity:.85}',
      '.row:hover{background:${T.paper}}',
      '.row.new{animation:fresh 1.2s ease-out}',
      '@keyframes fresh{from{background:rgba(165,150,214,.28)}to{background:transparent}}',
      '.row .n{color:${T.ink3};text-align:right}',
      '.row .at,.row .ms{color:${T.ink3}}',
      '.row .ms{text-align:right}',
      '.row .cmd{color:${T.accent}}',
      '.row .what{color:${T.ink};overflow-wrap:anywhere}',
      '.ok{color:${T.good}}.no{color:${T.bad}}',
      '.detail{grid-column:4/-1;padding:0 8px 3px 0;color:${T.ink2};white-space:pre-wrap;overflow-wrap:anywhere}',
      '.detail .no{color:${T.bad}}',
      ${JSON.stringify(contentKeys("ph", PHASES[s?.cmd ?? ""] ?? ["working"]))},
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
      const chip = el('div', 'chip' + (s.busy ? ' busy' : ''), '▌autobrowse ', side);
      chip.appendChild(el('span', s.busy ? 'run' : '', s.busy ? '● run' : '○ show'));
      chip.setAttribute('data-a', 'hide');
      root.appendChild(chip);
      document.documentElement.appendChild(host);
      ui.host = host;
      ui.root = root;
      return;
    }
    const tui = el('div', 'tui' + (s.busy ? ' busy' : '') + (ui.through ? ' through' : ''), null, side + ';width:' + ui.w + 'px');
    ui.tuiEl = tui;
    tui.appendChild(el('div', 'grip ' + (ui.right ? 'l' : 'r')));
    const bar = el('div', 'bar');
    bar.appendChild(el('span', 'name', '▌autobrowse'));
    bar.appendChild(el('span', 'state' + (s.busy ? ' run' : ''), s.busy ? '● run' : '○ idle'));
    if (s.step) bar.appendChild(el('span', 'k', 'step ' + s.step));
    bar.appendChild(el('span', 'fill'));
    if (s.meta) bar.appendChild(el('span', 'meta', s.meta));
    const btn = (a, t) => { const b = el('span', 'btn', t); b.setAttribute('data-a', a); return b; };
    const thru = btn('through', ui.through ? '[○]' : '[●]');
    if (ui.through) thru.className += ' on';
    thru.title = ui.through ? 'clicks pass to the page' : 'the panel takes clicks';
    const tip = (b, t) => { b.title = t; return b; };
    bar.appendChild(thru);
    bar.appendChild(tip(btn('move', ui.right ? '[◂]' : '[▸]'), 'move to the other side'));
    bar.appendChild(tip(btn('min', ui.min ? '[+]' : '[_]'), ui.min ? 'open' : 'fold'));
    bar.appendChild(tip(btn('hide', '[×]'), 'hide to a chip'));
    tui.appendChild(bar);
    if (!ui.min) {
      const body = el('div', 'body');
      const line = (k, cls, t) => { const d = el('div'); d.appendChild(el('span', 'k', k)); d.appendChild(el('span', cls, t)); return d; };
      if (s.goal) body.appendChild(line('goal ', 'goal', s.goal));
      if (s.thought) body.appendChild(line('» ', 'thought', s.thought));
      if (s.doing) body.appendChild(line('$ ', 'doing', s.doing));
      // The busy line: the hands' phase while a command runs; between commands, the agent's turn.
      const live = el('div', 'live');
      if (s.busy) {
        live.appendChild(el('span', 'spin'));
        const ph = el('span', 'phase', ' ', '--d:' + ${JSON.stringify(PHASES[s?.cmd ?? ""]?.length ?? 1)} * ${PHASE_S} + 's;--t:-' + since + 's');
        live.appendChild(ph);
        live.appendChild(el('span', 'dots'));
      } else if (s.goal) {
        live.appendChild(el('span', 'spin slow'));
        live.appendChild(el('span', '', ' thinking'));
        live.appendChild(el('span', 'dots'));
      } else {
        live.appendChild(el('span', 'k', '$ waiting for the agent'));
        live.appendChild(el('span', 'cursor'));
      }
      body.appendChild(live);
      tui.appendChild(body);
      const rule = el('div', 'rule');
      rule.appendChild(el('span', 't', '─ trace'));
      rule.appendChild(el('span', 't', String(s.trace.length)));
      rule.appendChild(el('span', 'fill', null, 'flex:1'));
      rule.appendChild(btn('trace', ui.trace ? '[▾]' : '[▸]'));
      tui.appendChild(rule);
      if (ui.trace && s.trace.length) {
        const rows = el('div', 'rows', null, ui.sized ? 'height:' + ui.h + 'px' : 'max-height:' + ui.h + 'px');
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
          if (r.note) row.appendChild(el('span', 'note' + (r.ok ? '' : ' no'), r.note));
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
export function overlayFor(startOn: boolean) {
  // `toggle` flips it for the session's life.
  let enabled = startOn;
  // A random attribute name: the page sees a node, never one that names us.
  const attr = `data-o${randomBytes(4).toString("hex")}`;
  let state: OverlayState = { ...EMPTY };
  let drawn = false;
  /** Commands and holds in flight: nested (a flow's steps inside its `flow` command), so a count. */
  let running = 0;
  let prefs: Prefs = {
    min: false,
    trace: true,
    right: false,
    hidden: false,
    // The panel takes a person's clicks; while a command runs it lets every click through.
    through: false,
    w: 460,
    h: 220,
    sized: false,
  };
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
    drawsOn(page, (fn) => off(page, fn));
  };
  /** `fn` runs with the layer off: a screenshot shows the page, not us. */
  const off = async <T>(page: Page, fn: () => Promise<T>): Promise<T> => {
    if (!enabled || !drawn) return fn();
    await paint(page, undefined);
    try {
      return await fn();
    } finally {
      await draw(page);
    }
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
    get enabled() {
      return enabled;
    },
    /** On or off at any time; off takes the layer down and keeps the trace for when it comes back. */
    async toggle(page: Page, on: boolean): Promise<{ drawn: boolean }> {
      enabled = on;
      if (on) await draw(page);
      else if (drawn) {
        drawn = false;
        await paint(page, undefined);
      }
      return { drawn: on };
    },
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
      if (clear)
        state = {
          ...EMPTY,
          trace: state.trace,
          busy: state.busy,
          cmd: state.cmd,
          meta: state.meta,
        };
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
    /** The bar's right side (seed, pace); drawn with the next change. */
    tag(meta: string | null): void {
      state.meta = meta;
    },
    /** A command starts: the panel goes inert before the act can reach the page. */
    async begin(page: Page, cmd?: string): Promise<void> {
      if (!enabled) return;
      running++;
      state.busy = true;
      state.cmd = cmd ?? null;
      if (drawn) await draw(page);
    },
    /** A command ended: its row joins the trace and the panel takes clicks again. */
    async end(page: Page, row: Omit<TraceRow, "n" | "at">): Promise<void> {
      if (!enabled) return;
      const n = (state.trace.at(-1)?.n ?? 0) + 1;
      const at = new Date().toTimeString().slice(0, 8);
      state.trace = [...state.trace, { ...row, n, at }].slice(-TRACE_KEEP);
      running = Math.max(0, running - 1);
      state.busy = running > 0;
      if (!state.busy) state.cmd = null;
      // The row holds the act now; the line waits for the next.
      state.doing = null;
      await draw(page);
    },
    /** Hands that may touch the page outside a command (a wait that clears a banner, a scroll): inert, no row. */
    async hold<T>(page: Page, fn: () => Promise<T>): Promise<T> {
      if (!enabled) return fn();
      running++;
      const was = state.busy;
      state.busy = true;
      if (!was && drawn) await draw(page);
      try {
        return await fn();
      } finally {
        running = Math.max(0, running - 1);
        if (running === 0) {
          state.busy = false;
          if (drawn) await draw(page);
        }
      }
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
    around: off,
    /** The session ends: nothing of ours stays on the page. */
    async remove(page: Page): Promise<void> {
      if (!drawn) return;
      drawn = false;
      state = { ...EMPTY };
      drawsOn(page, null);
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

/** What a command left: the page before and after, and its answer. */
export interface TraceSeen {
  from: string;
  to: string;
  answer?: unknown;
}

/** The dim line: counts and a path, never a value read or typed. */
function noteOf(c: Command, failed: unknown, seen: TraceSeen | undefined): string {
  if (failed)
    return (
      clipLine((failed instanceof Error ? failed.message : String(failed)).split("\n")[0], 90) ?? ""
    );
  if (!seen) return "";
  const a = (seen.answer ?? {}) as Record<string, unknown>;
  const ch = a.changed as { added?: unknown[]; gone?: number; more?: number } | undefined;
  const added = (ch?.added?.length ?? 0) + (ch?.more ?? 0);
  return [
    seen.to !== seen.from ? `→ ${shortUrl(seen.to)}` : null,
    ch && (added || ch.gone) ? `+${added} −${ch.gone ?? 0} controls` : ch ? "no change" : null,
    typeof a.text === "string" ? `${a.text.length} chars read` : null,
    typeof a.aria === "string" ? `${a.aria.split("\n").length} lines` : null,
    c.cmd === "type" || c.cmd === "fill" || c.cmd === "place" ? "typed, value hidden" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A command as one trace row: what it aimed at, never a typed value. */
export function traceRow(
  c: Command,
  failed: unknown,
  ms: number,
  seen?: TraceSeen,
): Omit<TraceRow, "n" | "at"> {
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
                : String(f.as ?? f.env ?? f.name ?? f.outcome ?? (hints ? hintLabel(hints) : ""));
  const what = typeof f.goal === "string" && f.goal ? `${f.goal} · ${aim}` : aim;
  const detail = [
    ...(hints ? [`target ${JSON.stringify(hints)}`] : []),
    ...(failed
      ? [`error ${clipLine(failed instanceof Error ? failed.message : String(failed), 400)}`]
      : []),
  ];
  return {
    cmd: c.cmd,
    what: clipLine(what, 200) ?? "",
    ok: !failed,
    ms: Math.round(ms),
    note: noteOf(c, failed, seen),
    detail,
  };
}
