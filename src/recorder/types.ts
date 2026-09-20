/**
 * What a recording is: the chore a person did once, as data. Actions carry
 * locator hints (role, name, text, label) rather than CSS paths, because
 * hints survive a redesign and CSS does not. Values are redacted at
 * capture time when the field or the value looks like a secret.
 */
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
}

interface Base {
  /** ms since the recording started. */
  t: number;
  url: string;
  screenshot?: string;
}

export type Action =
  | (Base & { kind: "navigate" })
  | (Base & { kind: "click"; target: LocatorHints })
  | (Base & { kind: "input"; target: LocatorHints; value: string; redacted: boolean })
  | (Base & { kind: "select"; target: LocatorHints; value: string })
  | (Base & { kind: "press"; target: LocatorHints; key: string })
  | (Base & { kind: "upload"; target: LocatorHints; files: string[] })
  | (Base & { kind: "submit"; target: LocatorHints })
  /** Text read off an element and kept under a name: the scraping half of a workflow. */
  | (Base & { kind: "read"; target: LocatorHints; as: string; value: string })
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

export const MANIFEST = "manifest.json";
