/**
 * What a recording is: the chore a person did once, as data. Actions carry
 * locator hints (role, name, text, label) rather than CSS paths, because
 * hints survive a redesign and CSS does not. Values are redacted at
 * capture time when the field or the value looks like a secret.
 */
import type { RecordsOp } from "../browser/records.js";
import type { DesktopOp } from "../desktop/types.js";

export interface LocatorHints {
  tag: string;
  role: string | null;
  /** Accessible name: aria-label, label text, button text, alt, title, placeholder. */
  name: string | null;
  text: string | null;
  placeholder: string | null;
  id: string | null;
  testId: string | null;
  href: string | null;
  inputType: string | null;
  /**
   * Last resorts, never captured by the recorder: a CSS selector when a
   * widget hides its control (React Select), and which match when a form
   * repeats a row of controls. Explore mode writes them; the compiler
   * keeps them.
   */
  css?: string | null;
  nth?: number | null;
  /**
   * The element is inside an iframe, named by this CSS selector. A
   * "Sign in with Google" button is one: Google renders it cross-origin, so
   * the page's own locators never reach it.
   */
  frame?: string | null;
}

interface Base {
  /** ms since the recording started. */
  t: number;
  url: string;
  screenshot?: string;
}

export type Action =
  | (Base & { kind: "navigate" })
  /** An act outside the browser (an app, a menu, a root command); typed text is redacted like input. */
  | (Base & { kind: "desktop"; op: DesktopOp; redacted: boolean })
  | (Base & { kind: "click"; target: LocatorHints })
  | (Base & {
      kind: "input";
      target: LocatorHints;
      value: string;
      redacted: boolean;
      /** The secret placed by name (`email`, `password`, `code`), when the value was one. */
      secret?: string;
    })
  /** `options`: the values the list offered (teach makes them a field's choices). */
  | (Base & { kind: "select"; target: LocatorHints; value: string; options?: string[] })
  | (Base & { kind: "press"; target: LocatorHints; key: string })
  | (Base & { kind: "upload"; target: LocatorHints; files: string[] })
  | (Base & { kind: "submit"; target: LocatorHints })
  /** Text read off an element and kept under a name: the scraping half of a workflow. */
  | (Base & { kind: "read"; target: LocatorHints; as: string; value: string })
  /** A list page read as rows by checked extractor code: a walk replays the op whole. */
  | (Base & { kind: "records"; op: RecordsOp })
  /** A secret read off the page (a minted API key) and put in the secret sink as `env`; the value is never here. */
  | (Base & { kind: "keep"; target: LocatorHints; env: string })
  | (Base & { kind: "note"; text: string })
  | (Base & { kind: "pause" })
  | (Base & { kind: "resume" });

export interface Recording {
  name: string;
  site: string;
  startedAt: string;
  finishedAt: string;
  actions: Action[];
  /** Relative to the recording dir. */
  trace: string | null;
  terminal: string | null;
  /** Shell commands typed during the terminal leg, redacted. */
  commands: string[];
}

/** A list row: what a table shows, without the actions themselves. */
export interface RecordingSummary {
  name: string;
  site: string;
  startedAt: string;
  finishedAt: string;
  actionCount: number;
  commandCount: number;
}

export const summarizeRecording = (r: Recording): RecordingSummary => ({
  name: r.name,
  site: r.site,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  actionCount: r.actions.length,
  commandCount: r.commands.length,
});

export const MANIFEST = "manifest.json";
/** The summary beside it: what a list reads, so listing never opens every action. */
export const SUMMARY = "summary.json";
