/**
 * The autotrack session format, copied from the autotrack repo (`src/events.ts`, which follows its
 * designs/2026-10-13-autotrack.md). The repos are separate, so no test can compare them: change
 * both or neither. `OcrFile` and `Labels` with its parts (end of file) are autobrowse's own: the first is
 * how it reads a shipped file, the last is what the offline pass writes.
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
  /** Up to 6 ancestors, nearest first. */
  path?: { role: string; name: string }[];
  /** AXIdentifier / UIA AutomationId. */
  id?: string;
  /** UIA ClassName / AXDOMClassList joined. */
  cls?: string;
  /** AXURL, for links. */
  url?: string;
  help?: string;
}

/** What the browser extension saw under the pointer (screen points). */
export interface WebTarget {
  tag: string;
  role?: string;
  name?: string;
  /** ≤ 200 chars. */
  text?: string;
  id?: string;
  testId?: string;
  css?: string;
  xpath?: string;
  href?: string;
  inputType?: string;
  /** aria-* and data-* names and values, ≤ 80 chars each, no value attrs. */
  attrs?: Record<string, string>;
  /** React component names, nearest first, ≤ 12. */
  react?: string[];
  rect?: { x: number; y: number; width: number; height: number };
}

/** What a web act did, on a follow-up `act: "effect"` event 1 s later. */
export interface WebEffects {
  /** When it changed. */
  url?: string;
  /** Origin + path, no query. */
  requests: { method: string; url: string; status: number; ms: number }[];
  dom: { added: number; removed: number; textChanged: number };
  /** Console errors and unhandled rejections in the 1 s window. */
  errors?: { message: string; source: string }[];
}

/** What an act did, written once its after-frame is known (signal section of the design doc). */
export interface Outcome {
  /** The frame hash moved. */
  screen: boolean;
  /** The front app or window changed. */
  focus: boolean;
  /** A dialog appeared. */
  dialog: boolean;
  /** A window opened or closed. */
  window: boolean;
}

/** The recorder's quality level (quality section of the design doc): how hard it was capturing. */
export type Level = "full" | "normal" | "lean";

/** The fields every act event (click, drag, scroll, text, key) may carry. */
interface ActExtras {
  out?: Outcome;
  /** The latest accessibility tree before the act (`trees/<n>.json`). */
  tree?: number;
  /** ms from the act's end until two grabs in a row hashed the same (the after frame). */
  settle?: number;
  /** False when 3 s ran out before the screen settled (a spinner, a video). */
  settled?: boolean;
}

/** What a click, drag or scroll adds: the cursor's approach and a native-pixel crop. */
interface PointerExtras {
  /** `[dt, x, y]`: the last 1 s before button-down, dt in ms (negative), global points; ≤ 60. */
  path?: [number, number, number][];
  /** `crops/<n>.jpg`: 256x256 points around the pointer at the display's native pixels. */
  crop?: number;
}

export type Event = Base &
  /** ≤ 20 Hz, ≥ 4 px */
  (
    | { kind: "move"; x: number; y: number }
    /** before/after = frame numbers */
    | (ActExtras &
        PointerExtras & {
          kind: "click";
          x: number;
          y: number;
          button: "left" | "right" | "middle";
          count: number;
          element?: Element;
          before?: number;
          after?: number;
        })
    | (ActExtras &
        PointerExtras & {
          kind: "drag";
          x0: number;
          y0: number;
          x: number;
          y: number;
          button: "left" | "right" | "middle";
          element?: Element;
          before?: number;
          after?: number;
        })
    /** wheel ticks folded per 250 ms */
    | (ActExtras &
        PointerExtras & {
          kind: "scroll";
          x: number;
          y: number;
          dx: number;
          dy: number;
          element?: Element;
          before?: number;
          after?: number;
        })
    /** printable keys folded, ends at 1 s idle, a click, or a non-text key */
    | (ActExtras & {
        kind: "text";
        text: string;
        redacted: boolean;
        element?: Element;
        before?: number;
        after?: number;
      })
    /** enter, tab, arrows, esc, backspace runs, and any combo */
    | (ActExtras & {
        kind: "key";
        key: string;
        mods: ("ctrl" | "alt" | "shift" | "meta")[];
        element?: Element;
        before?: number;
        after?: number;
      })
    /** app or window changed (app/window on Base) */
    | { kind: "focus" }
    /** a screen change with no act (idle reading) */
    | { kind: "frame"; frame: number }
    | { kind: "pause"; reason: "hotkey" | "cli" | "excluded" | "locked" }
    | { kind: "resume" }
    | {
        kind: "web";
        act: string;
        tab: number;
        frame: number;
        url: string;
        title: string;
        x?: number;
        y?: number;
        target?: WebTarget;
        effects?: WebEffects;
        /** `effect` events: the act they describe. */
        cause?: { act: string; ts: number };
        button?: string;
        count?: number;
        /** `nav`: `from` url and the webNavigation transition (link, typed, reload, form_submit, back_forward…). */
        from?: string;
        transition?: string;
        /** `tab`: open | close | switch, and how many tabs are open. */
        op?: "open" | "close" | "switch";
        /** `search`. */
        engine?: string;
        query?: string;
        /** `copy`, `cut`, `paste`, `select`: ≤ 2,000 chars, through redaction. */
        text?: string;
        /** `download`: never the file. */
        ext?: string;
        mime?: string;
        bytes?: number;
        origin?: string;
        /** `snapshot`: the page's accessibility outline, or `treeFile` when stored as `trees/<n>.txt`. */
        tree?: string;
        treeFile?: number;
      }
    | { kind: "app"; url: string; action: string; detail: unknown }
    /** An accessibility tree was stored as `trees/<tree>.json`. */
    | { kind: "tree"; tree: number }
    /** The front window became an alert, sheet or modal dialog. */
    | { kind: "dialog"; title: string; text: string; buttons: string[] }
    | { kind: "clipboard"; types: string[]; length: number; text?: string; redacted: boolean }
    /** The person's own "why"; `goal: ""` with `done` closes the task. */
    | { kind: "task"; goal: string; done?: boolean }
    /** The quality level changed; every act after it was captured at `level`. `why` names the input. */
    | { kind: "level"; level: Level; why: string }
    /**
     * One per written frame: `at` is the grab's `t` (a ring frame can be older than the act), `x, y`
     * the cursor then (screenshots carry no cursor), `display` the display it was grabbed from.
     */
    | { kind: "shot"; frame: number; at: number; x: number; y: number; display: string }
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
  /** Running totals over the session's closed segments (`Stats` summed). */
  totals?: Stats;
}

/**
 * `<segment>/stats.json` (shipped as `.gz`), written when a segment closes: what the recorder did,
 * so a trainer can filter on integrity. `session.json` `totals` is the sum over the session.
 * `recovered`: closed by the next start after a crash, so only what the files show is counted.
 */
export interface Stats {
  /** Events written, by kind. */
  events: Record<string, number>;
  /** Raw pointer moves the 20 Hz / 4 px fold dropped. */
  movesDropped: number;
  /** Probe asks (at, focused, front, tree) that answered, and that timed out or had no helper. */
  probe: { answers: number; timeouts: number };
  /** Acts written with no element. */
  nullElement: number;
  frames: { saved: number; failed: number; slotReused: number };
  trees: number;
  crops: number;
  /** Images read; `same`: a frame whose hash matched one already read; `skipped`: not read in time. */
  ocr: { done: number; same: number; failed: number; skipped: number };
  /** Seconds at each level. */
  levels: Record<Level, number>;
  /** Helper (re)starts after the first, by helper. */
  restarts: Record<string, number>;
  recovered?: boolean;
}

/** One line of recognised text, in the image's own pixels (`ocr/<n>.json.gz`, `ocr/c<n>.json.gz`). */
export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
}

/** An OCR file: the lines, or `{same: m}` when frame `m` (same hash) was already read. */
export type OcrFile = { lines: OcrLine[] } | { same: number };

export type EpisodeOutcome = "done" | "failed" | "abandoned" | "unclear";

/** The rule signals of one act (design doc, "Derived offline"). */
export interface ActSignals {
  /** ms since the last act. */
  dwell: number;
  /** ms the pointer rested on the target before the act; absent for acts with no pointer. */
  hover?: number;
  dead: boolean;
  rage: boolean;
  correction: boolean;
  error: boolean;
}

/** `labels/<device>/<session>.json`. `model` (not in the doc) says who labelled: null = rules only. */
export interface Labels {
  v: 1;
  session: string;
  model?: string | null;
  episodes: {
    id: string;
    start: number;
    end: number;
    goal: string;
    goalBy: "person" | "model";
    outcome: EpisodeOutcome;
    confidence: number;
  }[];
  acts: { t: number; episode: string; intent: string; signals: ActSignals }[];
}
