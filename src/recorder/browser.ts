/**
 * Records one browser session: the observer's actions, a screenshot after
 * each, main-frame navigations, a Playwright trace. `control` is the play/
 * pause button and the note pad; while paused nothing is captured, and a
 * marker says so, so a person can type a secret or do a private step.
 */
import { mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { inPage } from "../browser/in-page.js";
import type { Session } from "../browser/session.js";
import type { DistributiveOmit } from "../types.js";
import { BINDING, OBSERVER_SCRIPT } from "./observer.js";
import { looksLikeSecretField, looksLikeSecretValue, REDACTED } from "./redact.js";
import type { Action, LocatorHints } from "./types.js";

type ActionBody = DistributiveOmit<Action, "t" | "url" | "screenshot">;

export interface RecorderControl {
  paused: boolean;
  pause(): void;
  play(): void;
  note(text: string): void;
  /** Ends the recording; resolves once the browser is closed. */
  stop(): void;
  onStop(fn: () => void): void;
}

export function recorderControl(): RecorderControl {
  const listeners: Array<() => void> = [];
  const c: RecorderControl & { noteFn: (t: string) => void } = {
    paused: false,
    noteFn: () => undefined,
    pause() {
      c.paused = true;
    },
    play() {
      c.paused = false;
    },
    note(text) {
      c.noteFn(text);
    },
    stop() {
      for (const l of listeners) l();
    },
    onStop(fn) {
      listeners.push(fn);
    },
  };
  return c;
}

/** What the observer script sends over the binding, before redaction. */
export type RawAction =
  | { kind: "click"; target: LocatorHints }
  | { kind: "input"; target: LocatorHints; value: string }
  | { kind: "select"; target: LocatorHints; value: string; options?: string[] }
  | { kind: "press"; target: LocatorHints; key: string }
  | { kind: "submit"; target: LocatorHints };

/** A typed secret never reaches the journal: the field or the value gives it away. */
export function redactRaw(raw: RawAction): ActionBody {
  if (raw.kind !== "input") return raw;
  const secret = looksLikeSecretField(raw.target) || looksLikeSecretValue(raw.value);
  return {
    kind: "input",
    target: raw.target,
    value: secret ? REDACTED : raw.value,
    redacted: secret,
  };
}

export interface BrowserRecording {
  actions: Action[];
  /** Relative to `dir`. */
  trace: string | null;
}

export interface ActiveRecording {
  /** Resolves when the browser closes or `control.stop()` is called. */
  finished: Promise<BrowserRecording>;
}

/** Hooks the page, then resolves; interact after that. */
export async function startBrowserRecording(opts: {
  session: Session;
  dir: string;
  startUrl: string | null;
  control: RecorderControl;
  now?: () => number;
}): Promise<ActiveRecording> {
  const { session, dir, control } = opts;
  const now = opts.now ?? Date.now;
  const t0 = now();
  const actions: Action[] = [];
  const shots = join(dir, "screenshots");
  mkdirSync(shots, { recursive: true });
  let shotN = 0;
  let wasPaused = false;

  const screenshot = async (): Promise<string | undefined> => {
    const file = join(shots, `${String(shotN++).padStart(4, "0")}.png`);
    const ok = await session.page.screenshot({ path: file }).then(
      () => true,
      () => false,
    );
    return ok ? relative(dir, file) : undefined;
  };
  const push = async (a: ActionBody, shot = true) => {
    const base = { t: now() - t0, url: session.page.url() };
    const action = { ...base, ...a } as Action;
    if (shot) {
      const s = await screenshot();
      if (s) action.screenshot = s;
    }
    actions.push(action);
  };
  /** Pause and resume markers come from the control's state, seen at the next event. */
  const markers = async () => {
    if (control.paused && !wasPaused) {
      wasPaused = true;
      await push({ kind: "pause" }, false);
    } else if (!control.paused && wasPaused) {
      wasPaused = false;
      await push({ kind: "resume" }, false);
    }
  };

  const tracing = await session.context.tracing
    .start({ screenshots: true, snapshots: true })
    .then(() => true)
    .catch(() => false);

  await session.context.exposeBinding(BINDING, async (_src, raw: RawAction) => {
    await markers();
    if (control.paused) return;
    await push(redactRaw(raw));
  });
  await session.context.addInitScript(OBSERVER_SCRIPT);
  session.page.on("framenavigated", (frame) => {
    if (frame !== session.page.mainFrame()) return;
    void markers().then(() => (control.paused ? undefined : push({ kind: "navigate" }, false)));
  });
  (control as RecorderControl & { noteFn: (t: string) => void }).noteFn = (text) => {
    void push({ kind: "note", text }, false);
  };

  if (opts.startUrl) await session.page.goto(opts.startUrl).catch(() => undefined);
  else await inPage(session.page, OBSERVER_SCRIPT).catch(() => undefined);

  const finished = (async (): Promise<BrowserRecording> => {
    await new Promise<void>((resolve) => {
      session.context.on("close", () => resolve());
      control.onStop(() => resolve());
    });
    let trace: string | null = null;
    if (tracing) {
      const file = join(dir, "trace.zip");
      trace = await session.context.tracing.stop({ path: file }).then(
        () => "trace.zip",
        () => null,
      );
    }
    await session.close();
    return { actions, trace };
  })();
  return { finished };
}
