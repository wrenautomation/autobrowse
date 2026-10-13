/**
 * Rule signals per act, no model (design doc "Derived offline", step 2): dwell, hover, dead, rage,
 * correction, error. Each is a pure function of the acts and the raw events around them, so a rule
 * change reruns over old data. A signal never guesses: with no evidence an act is not `dead`, and
 * an act with no pointer has no `hover`.
 */
import type { Act } from "./join.js";
import type { ActSignals, Event } from "./types.js";

type MoveEvent = Extract<Event, { kind: "move" }>;
type DialogEvent = Extract<Event, { kind: "dialog" }>;
type FocusEvent = Extract<Event, { kind: "focus" }>;

export const RAGE_CLICKS = 3;
export const RAGE_MS = 2000;
/** Max pointer lookback for hover, so one parked cursor does not read as minutes of attention. */
export const HOVER_LOOKBACK_MS = 10_000;
export const HOVER_PAD_PX = 4;
export const HOVER_NEAR_PX = 8;
export const SAME_POINT_PX = 6;
export const BACK_WITHIN_MS = 5000;
/** A dialog or focus change this soon after an act is its doing. */
export const REACT_MS = 2000;
const FOCUS_MS = 1000;

/** ms since the previous act ended; the first act has none, so 0. */
export function dwellOf(acts: readonly Act[], i: number): number {
  const prev = acts[i - 1];
  const a = acts[i];
  if (!prev || !a) return 0;
  return Math.max(0, a.ts - prev.end);
}

function inRegion(act: Act, x: number, y: number): boolean {
  const r = act.target?.rect ?? act.element;
  if (r && r.width > 0 && r.height > 0) {
    if (
      x >= r.x - HOVER_PAD_PX &&
      x <= r.x + r.width + HOVER_PAD_PX &&
      y >= r.y - HOVER_PAD_PX &&
      y <= r.y + r.height + HOVER_PAD_PX
    )
      return true;
  }
  return act.x !== undefined && act.y !== undefined
    ? Math.hypot(x - act.x, y - act.y) <= HOVER_NEAR_PX
    : false;
}

/**
 * ms the pointer rested on the act's target before it: from the first of the unbroken run of
 * moves inside the target's rect (or near the click point) that ends at the act. Only pointer acts
 * (`click`, `drag`) have one; undefined when no move landed there. `moves` sorted by `ts`.
 */
export function hoverOf(
  act: Act,
  moves: readonly MoveEvent[],
  floorTs: number,
): number | undefined {
  if (act.kind !== "click" && act.kind !== "drag") return undefined;
  const e = act.event;
  const probe: Act = e.kind === "drag" ? { ...act, x: e.x0, y: e.y0 } : act;
  if (probe.x === undefined || probe.y === undefined) return undefined;
  const floor = Math.max(floorTs, act.ts - HOVER_LOOKBACK_MS);
  // The latest move at or before the act, then walk back.
  let hi = moves.length - 1;
  while (hi >= 0 && (moves[hi] as MoveEvent).ts > act.ts) hi--;
  let first: MoveEvent | undefined;
  for (let k = hi; k >= 0; k--) {
    const m = moves[k] as MoveEvent;
    if (m.ts < floor) break;
    if (!inRegion(probe, m.x, m.y)) break;
    first = m;
  }
  return first ? Math.max(0, act.ts - first.ts) : undefined;
}

const ACTS_THAT_CAN_BE_DEAD = new Set(["click", "drag"]);

/**
 * Nothing came of it: no screen change, no focus change, no dialog, no window, no request, no DOM
 * change, no navigation. Only clicks and drags can be dead (a copy or a scroll is allowed to leave
 * no mark), and only when something measured it: the recorder's `out`, or the browser's effects.
 */
export function isDead(
  act: Act,
  after: { dialogs: readonly DialogEvent[]; focuses: readonly FocusEvent[] },
): boolean {
  if (!ACTS_THAT_CAN_BE_DEAD.has(act.kind)) return false;
  const out = "out" in act.event ? act.event.out : undefined;
  const fx = act.effects;
  if (!out && !fx) return false;
  if (out && (out.screen || out.focus || out.dialog || out.window)) return false;
  if (fx) {
    if (fx.url || fx.requests.length > 0) return false;
    if (fx.dom.added + fx.dom.removed + fx.dom.textChanged > 0) return false;
    if (fx.errors?.length) return false;
  }
  if (act.navs.length > 0 || act.appEvents.length > 0) return false;
  const until = act.ts + FOCUS_MS;
  if (after.dialogs.some((d) => d.ts >= act.ts && d.ts <= until)) return false;
  if (after.focuses.some((f) => f.ts > act.ts && f.ts <= until)) return false;
  return true;
}

const targetId = (a: Act): string | undefined => {
  const t = a.target;
  if (!t) return undefined;
  return t.xpath ?? t.css ?? t.id ?? t.testId ?? (t.text ? `${t.tag}:${t.text}` : undefined);
};

/** The same thing on screen: the same page element, else the same named control in the same place, else the same spot. */
export function sameTarget(a: Act, b: Act): boolean {
  const ia = targetId(a);
  const ib = targetId(b);
  if (ia && ib) return ia === ib;
  const ea = a.element;
  const eb = b.element;
  if (ea?.name && eb?.name)
    return (
      ea.role === eb.role &&
      ea.name === eb.name &&
      Math.abs(ea.x - eb.x) <= HOVER_PAD_PX &&
      Math.abs(ea.y - eb.y) <= HOVER_PAD_PX
    );
  if (a.x === undefined || a.y === undefined || b.x === undefined || b.y === undefined)
    return false;
  return Math.hypot(a.x - b.x, a.y - b.y) <= SAME_POINT_PX;
}

const buttonOf = (a: Act): string =>
  a.event.kind === "click" ? a.event.button : (a.web?.button ?? "left");

/**
 * Rage: three or more clicks on one target inside 2 s. Every click of such a burst is flagged,
 * not only the third. A double click is two clicks and is not rage.
 */
export function rageFlags(acts: readonly Act[]): boolean[] {
  const flags = acts.map(() => false);
  const clicks = acts.flatMap((a, i) => (a.kind === "click" ? [{ a, i }] : []));
  for (let k = 0; k < clicks.length; k++) {
    const last = clicks[k] as { a: Act; i: number };
    const burst = [last];
    for (let j = k - 1; j >= 0; j--) {
      const c = clicks[j] as { a: Act; i: number };
      if (last.a.ts - c.a.ts > RAGE_MS) break;
      if (buttonOf(c.a) === buttonOf(last.a) && sameTarget(c.a, last.a)) burst.push(c);
    }
    if (burst.length >= RAGE_CLICKS) for (const c of burst) flags[c.i] = true;
  }
  return flags;
}

/** How long a text run could have lasted: typing a character takes up to 400 ms. */
const typingMs = (text: string | undefined) => 5000 + 400 * (text?.length ?? 40);

function isBackspace(a: Act): boolean {
  return a.event.kind === "key" && a.event.key === "backspace" && a.event.mods.length === 0;
}

function isUndo(a: Act): boolean {
  const e = a.event;
  return (
    e.kind === "key" &&
    e.key === "z" &&
    !e.mods.includes("shift") &&
    (e.mods.includes("ctrl") || e.mods.includes("meta"))
  );
}

function isBackKey(a: Act): boolean {
  const e = a.event;
  if (e.kind !== "key") return false;
  return (
    (e.mods.includes("alt") && e.key === "left") ||
    (e.mods.includes("meta") && (e.key === "[" || e.key === "left"))
  );
}

/**
 * A correction undoes the person's own last move: an undo, a back navigation within 5 s of the
 * act that went there, a backspace run over text typed just before (no other act between), or a
 * text run that was typed and erased whole. Backspacing anywhere else is editing, not correcting.
 */
export function correctionFlags(acts: readonly Act[]): boolean[] {
  return acts.map((a, i) => {
    if (isUndo(a)) return true;
    const gap = dwellOf(acts, i);
    if (i > 0 && gap <= BACK_WITHIN_MS) {
      if (isBackKey(a)) return true;
      if (a.web?.act === "nav" && a.web.transition === "back_forward") return true;
    }
    if (a.kind === "text") return a.text === "" && a.redacted === false;
    if (!isBackspace(a)) return false;
    // The act before this run of backspaces.
    let k = i - 1;
    while (k >= 0 && isBackspace(acts[k] as Act)) k--;
    const typed = acts[k];
    if (typed?.kind !== "text" || !typed.text) return false;
    if (typed.app?.id && a.app?.id && typed.app.id !== a.app.id) return false;
    return a.ts - typed.ts <= typingMs(typed.text);
  });
}

/** A dialog, a failed request or a console error right after the act. */
export function hasError(act: Act, dialogs: readonly DialogEvent[]): boolean {
  const fx = act.effects;
  if (fx?.requests.some((r) => r.status === 0 || r.status >= 400)) return true;
  if (fx?.errors?.length) return true;
  return dialogs.some((d) => d.ts >= act.ts && d.ts <= act.ts + REACT_MS);
}

/** All signals for `acts`, in order. `events` is the whole session (moves, dialogs, focus changes). */
export function signalsFor(acts: readonly Act[], events: readonly Event[]): ActSignals[] {
  const moves = events.filter((e): e is MoveEvent => e.kind === "move").sort((a, b) => a.ts - b.ts);
  const dialogs = events.filter((e): e is DialogEvent => e.kind === "dialog");
  const focuses = events.filter((e): e is FocusEvent => e.kind === "focus");
  const rage = rageFlags(acts);
  const correction = correctionFlags(acts);
  return acts.map((a, i) => {
    const hover = hoverOf(a, moves, i > 0 ? (acts[i - 1] as Act).end : Number.NEGATIVE_INFINITY);
    return {
      dwell: dwellOf(acts, i),
      ...(hover !== undefined ? { hover } : {}),
      dead: isDead(a, { dialogs, focuses }),
      rage: rage[i] ?? false,
      correction: correction[i] ?? false,
      error: hasError(a, dialogs),
    };
  });
}
