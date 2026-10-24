/**
 * Whether browsers show on this machine's screen. One switch for every
 * browser autobrowse opens from now on (flows, explore and agent sessions,
 * proofs); `BROWSER_HEADLESS` is its value at boot, the API and UI flip it
 * while the worker runs. A browser already open keeps the mode it opened in.
 */
import type { Settings } from "./config.js";

export interface Display {
  headless: boolean;
}

export function displayOf(settings: Pick<Settings, "browserHeadless">): Display {
  return { headless: settings.browserHeadless };
}

/** A fixed choice where a person asked for one (`--headed`, `record`). */
export const headed: Display = Object.freeze({ headless: false });
