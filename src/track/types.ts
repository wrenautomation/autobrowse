/**
 * The wren-track session format, copied from designs/2026-10-13-track.md ("Session format"). The
 * doc is the source of truth; a test checks these equal `track/src/events.ts`. Change both or
 * neither.
 */

export interface Base {
  /** ms since session start (monotonic). */
  t: number;
  /** epoch ms. */
  ts: number;
  /** id: bundle id (Mac) / exe path (Windows). */
  app?: { name: string; id: string; pid: number };
  window?: { title: string; x: number; y: number; width: number; height: number };
  /** Display id the act is on. */
  display?: string;
}

/** Never the element's value. */
export interface Element {
  role: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  secure: boolean;
}

export type Event = Base &
  /** ≤ 20 Hz, ≥ 4 px */
  (
    | { kind: "move"; x: number; y: number }
    /** before/after = frame numbers */
    | {
        kind: "click";
        x: number;
        y: number;
        button: "left" | "right" | "middle";
        count: number;
        element?: Element;
        before?: number;
        after?: number;
      }
    | {
        kind: "drag";
        x0: number;
        y0: number;
        x: number;
        y: number;
        button: "left" | "right" | "middle";
        element?: Element;
        before?: number;
        after?: number;
      }
    /** wheel ticks folded per 250 ms */
    | {
        kind: "scroll";
        x: number;
        y: number;
        dx: number;
        dy: number;
        element?: Element;
        before?: number;
        after?: number;
      }
    /** printable keys folded, ends at 1 s idle, a click, or a non-text key */
    | {
        kind: "text";
        text: string;
        redacted: boolean;
        element?: Element;
        before?: number;
        after?: number;
      }
    /** enter, tab, arrows, esc, backspace runs, and any combo */
    | {
        kind: "key";
        key: string;
        mods: ("ctrl" | "alt" | "shift" | "meta")[];
        element?: Element;
        before?: number;
        after?: number;
      }
    /** app or window changed (app/window on Base) */
    | { kind: "focus" }
    /** a screen change with no act (idle reading) */
    | { kind: "frame"; frame: number }
    | { kind: "pause"; reason: "hotkey" | "cli" | "excluded" | "locked" }
    | { kind: "resume" }
  );

/**
 * `session.json`. The doc does not say whether `startedAt`/`endedAt` are epoch ms or ISO text;
 * the reader takes both.
 */
export interface SessionMeta {
  v: 1;
  session: string;
  device: string;
  os: string;
  osVersion: string;
  arch: string;
  trackVersion: string;
  startedAt: number | string;
  endedAt: number | string | null;
  displays: {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
    primary: boolean;
  }[];
}
