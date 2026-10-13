/**
 * Events → acts. One act is one thing the person did: an OS `click`, `drag`, `scroll`, `text` or
 * `key`, or a browser-only act (a navigation they typed, a search, a tab switch, a copy, a download).
 * The design doc's join (autotrack repo designs/2026-10-13-autotrack.md, "Derived offline"): an OS
 * `click` and a `web` `click` are the same act when `|ts| < 150 ms` and the points are within
 * 4 px; the web target replaces a thin OS element. Web `effect` events fold into the act that
 * caused them; `app` events ("approve-message") ride on the act just before.
 *
 * Pure: the same events give the same acts. Nothing here reads a file or a clock.
 */
import type { Element, Event, WebEffects, WebTarget } from "./types.js";

export type WebEvent = Extract<Event, { kind: "web" }>;
export type AppEvent = Extract<Event, { kind: "app" }>;
type OsClick = Extract<Event, { kind: "click" }>;

export const JOIN_MS = 150;
export const JOIN_PX = 4;

export type ActKind =
  | "click"
  | "drag"
  | "scroll"
  | "text"
  | "key"
  | "nav"
  | "tab"
  | "search"
  | "copy"
  | "cut"
  | "paste"
  | "select"
  | "download"
  | "app";

export interface Act {
  kind: ActKind;
  /** ms since session start, of the act's first event. */
  t: number;
  /** epoch ms. */
  ts: number;
  /** epoch ms of the act's last event: later than `ts` only for a scroll run. */
  end: number;
  /** The event the act is named for: the OS one when there is one. */
  event: Event;
  /** The joined or standalone browser event, with its `act` (`click`, `nav`, `search`…). */
  web?: WebEvent;
  /** The OS element, or the web target as one when the OS element is thin. */
  element?: Element;
  target?: WebTarget;
  /** Pointer acts: where, in global points. */
  x?: number;
  y?: number;
  /** Clicks: 1, 2, 3 (the OS count). */
  count: number;
  app?: Event["app"];
  window?: Event["window"];
  url?: string;
  /** `text` acts. */
  text?: string;
  redacted?: boolean;
  /** Everything the browser saw come of it, all effect windows folded together. */
  effects?: WebEffects;
  /** Browser navigations that followed the act (a link click's page load). */
  navs: { url: string; from?: string; transition?: string }[];
  /** `app` events the page emitted right after. */
  appEvents: { action: string; detail: unknown; ts: number }[];
}

const WEB_POINTER = new Set(["click", "dblclick", "contextmenu"]);
/** Navigations a person starts; a link or form submit is the click's result, not an act. */
const OWN_NAV = new Set([
  "typed",
  "reload",
  "back_forward",
  "auto_bookmark",
  "generated",
  "keyword",
  "keyword_generated",
  "start_page",
]);
const CLIPBOARD_KEY: Record<string, "copy" | "cut" | "paste"> = { c: "copy", x: "cut", v: "paste" };
const WEB_ACT_KIND = new Set(["tab", "search", "copy", "cut", "paste", "select", "download"]);

/** How long after an act its effects, navs and app events still belong to it. */
const TAIL_MS = 3000;
const APP_TAIL_MS = 2000;
const CLIPBOARD_JOIN_MS = 400;
const SCROLL_MERGE_MS = 1500;

/** Roles and names that tell nothing: a thin OS element is one the web target should replace. */
const GENERIC_ROLES = new Set([
  "axgroup",
  "axwebarea",
  "axunknown",
  "axscrollarea",
  "axsplitgroup",
  "group",
  "pane",
  "document",
  "custom",
  "window",
]);

export function isThin(el: Element | undefined): boolean {
  if (!el) return true;
  return !el.name.trim() || GENERIC_ROLES.has(el.role.toLowerCase());
}

function elementFromTarget(t: WebTarget, fallback?: Element): Element {
  return {
    role: t.role || t.tag,
    name: (t.name || t.text || "").trim(),
    x: t.rect?.x ?? fallback?.x ?? 0,
    y: t.rect?.y ?? fallback?.y ?? 0,
    width: t.rect?.width ?? fallback?.width ?? 0,
    height: t.rect?.height ?? fallback?.height ?? 0,
    secure: t.inputType === "password" || (fallback?.secure ?? false),
    ...(t.id ? { id: t.id } : {}),
    ...(t.href ? { url: t.href } : {}),
  };
}

/**
 * Pair OS clicks with web clicks. Every candidate pair (|Δts| < 150 ms, ≤ 4 px) is ranked by time
 * gap, then distance; the best pair is taken and both ends are spent, so two quick clicks never
 * share one browser event.
 */
export function joinClicks(
  os: readonly OsClick[],
  web: readonly WebEvent[],
): Map<OsClick, WebEvent> {
  const pairs: { o: OsClick; w: WebEvent; dt: number; d: number }[] = [];
  for (const w of web) {
    if (!WEB_POINTER.has(w.act) || w.x === undefined || w.y === undefined) continue;
    for (const o of os) {
      const dt = Math.abs(o.ts - w.ts);
      const d = Math.hypot(o.x - w.x, o.y - w.y);
      if (dt < JOIN_MS && d <= JOIN_PX) pairs.push({ o, w, dt, d });
    }
  }
  pairs.sort((a, b) => a.dt - b.dt || a.d - b.d);
  const out = new Map<OsClick, WebEvent>();
  const spent = new Set<WebEvent>();
  for (const p of pairs) {
    if (out.has(p.o) || spent.has(p.w)) continue;
    out.set(p.o, p.w);
    spent.add(p.w);
  }
  return out;
}

export function mergeEffects(a: WebEffects | undefined, b: WebEffects): WebEffects {
  if (!a) return { ...b, requests: [...b.requests], dom: { ...b.dom } };
  const errors = [...(a.errors ?? []), ...(b.errors ?? [])];
  const url = b.url ?? a.url;
  return {
    ...(url ? { url } : {}),
    requests: [...a.requests, ...b.requests],
    dom: {
      added: a.dom.added + b.dom.added,
      removed: a.dom.removed + b.dom.removed,
      textChanged: a.dom.textChanged + b.dom.textChanged,
    },
    ...(errors.length ? { errors } : {}),
  };
}

function blank(kind: ActKind, e: Event): Act {
  return {
    kind,
    t: e.t,
    ts: e.ts,
    end: e.ts,
    event: e,
    count: 1,
    ...(e.app ? { app: e.app } : {}),
    ...(e.window ? { window: e.window } : {}),
    navs: [],
    appEvents: [],
  };
}

function withWeb(act: Act, w: WebEvent): void {
  act.web = w;
  if (w.url) act.url = w.url;
  if (w.target) {
    act.target = w.target;
    if (act.element === undefined || isThin(act.element))
      act.element = elementFromTarget(w.target, act.element);
  }
}

/** The acts of a session, in time order. */
export function buildActs(events: readonly Event[]): Act[] {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const osClicks = sorted.filter((e): e is OsClick => e.kind === "click");
  const webs = sorted.filter((e): e is WebEvent => e.kind === "web");
  const joined = joinClicks(osClicks, webs);
  const joinedWeb = new Set(joined.values());

  const acts: Act[] = [];
  /** Which act a web event is part of, for effects to find their cause. */
  const owner = new Map<WebEvent, Act>();
  const looseEffects: WebEvent[] = [];
  const looseNavs: WebEvent[] = [];
  const searches = webs.filter((w) => w.act === "search");

  for (const e of sorted) {
    switch (e.kind) {
      case "click": {
        const a = blank("click", e);
        a.x = e.x;
        a.y = e.y;
        a.count = e.count;
        if (e.element) a.element = e.element;
        const w = joined.get(e);
        if (w) {
          withWeb(a, w);
          owner.set(w, a);
        }
        acts.push(a);
        break;
      }
      case "drag": {
        const a = blank("drag", e);
        a.x = e.x;
        a.y = e.y;
        if (e.element) a.element = e.element;
        acts.push(a);
        break;
      }
      case "scroll": {
        const a = blank("scroll", e);
        a.x = e.x;
        a.y = e.y;
        if (e.element) a.element = e.element;
        const prev = acts[acts.length - 1];
        if (
          prev?.kind === "scroll" &&
          prev.event.kind === "scroll" &&
          prev.app?.id === a.app?.id &&
          e.ts - prev.ts <= SCROLL_MERGE_MS
        ) {
          // One scroll act per run: the first event stands for it, the distance adds up.
          prev.event = { ...prev.event, dx: prev.event.dx + e.dx, dy: prev.event.dy + e.dy };
          prev.end = e.ts;
          break;
        }
        acts.push(a);
        break;
      }
      case "text": {
        const a = blank("text", e);
        a.text = e.text;
        a.redacted = e.redacted;
        if (e.element) a.element = e.element;
        acts.push(a);
        break;
      }
      case "key": {
        const a = blank("key", e);
        if (e.element) a.element = e.element;
        acts.push(a);
        break;
      }
      case "web": {
        if (WEB_POINTER.has(e.act)) {
          // A joined one is already part of its OS click; an unmatched `click` stands alone (the
          // OS side missed it), an unmatched `dblclick` only repeats a click already counted.
          if (joinedWeb.has(e) || e.act === "dblclick" || e.x === undefined || e.y === undefined)
            break;
          const a = blank("click", e);
          a.x = e.x;
          a.y = e.y;
          a.count = e.count ?? 1;
          withWeb(a, e);
          owner.set(e, a);
          acts.push(a);
        } else if (e.act === "effect") {
          looseEffects.push(e);
        } else if (e.act === "nav") {
          const near = searches.some((s) => s.tab === e.tab && Math.abs(s.ts - e.ts) <= 1000);
          if (e.transition && OWN_NAV.has(e.transition) && !near) {
            const a = blank("nav", e);
            withWeb(a, e);
            owner.set(e, a);
            acts.push(a);
          } else looseNavs.push(e);
        } else if (e.act === "copy" || e.act === "cut" || e.act === "paste") {
          const want = e.act;
          const key = [...acts]
            .reverse()
            .find(
              (a) =>
                a.event.kind === "key" &&
                !a.web &&
                Math.abs(a.ts - e.ts) <= CLIPBOARD_JOIN_MS &&
                CLIPBOARD_KEY[a.event.key] === want &&
                (a.event.mods.includes("ctrl") || a.event.mods.includes("meta")),
            );
          if (key) {
            withWeb(key, e);
            owner.set(e, key);
          } else {
            const a = blank(want, e);
            withWeb(a, e);
            owner.set(e, a);
            acts.push(a);
          }
        } else if (WEB_ACT_KIND.has(e.act)) {
          const a = blank(e.act as ActKind, e);
          withWeb(a, e);
          owner.set(e, a);
          acts.push(a);
        }
        // pointerdown, change, key, scroll, snapshot, submit: seen by their OS twins or by effects.
        break;
      }
      default:
        break;
    }
  }

  /** The last act that started at or before `ts`, no more than TAIL_MS back. */
  const before = (ts: number): Act | undefined => {
    for (let i = acts.length - 1; i >= 0; i--) {
      const a = acts[i] as Act;
      if (a.ts <= ts + JOIN_MS) return ts - a.ts <= TAIL_MS ? a : undefined;
    }
    return undefined;
  };

  for (const e of looseEffects) {
    if (!e.effects) continue;
    let target: Act | undefined;
    if (e.cause) {
      const cause = webs.find((w) => w.act === e.cause?.act && w.ts === e.cause.ts);
      target = (cause && owner.get(cause)) || before(e.cause.ts);
    }
    target ??= before(e.ts);
    if (target) target.effects = mergeEffects(target.effects, e.effects);
  }
  for (const e of looseNavs) {
    const target = before(e.ts);
    if (target)
      target.navs.push({
        url: e.url,
        ...(e.from ? { from: e.from } : {}),
        ...(e.transition ? { transition: e.transition } : {}),
      });
  }
  for (const e of sorted) {
    if (e.kind !== "app") continue;
    const prev = [...acts].reverse().find((a) => a.ts <= e.ts);
    const note = { action: e.action, detail: e.detail, ts: e.ts };
    if (prev && e.ts - prev.ts <= APP_TAIL_MS) prev.appEvents.push(note);
    else {
      const a = blank("app", e);
      a.url = e.url;
      a.appEvents.push(note);
      acts.push(a);
    }
  }
  return acts.sort((a, b) => a.ts - b.ts);
}
