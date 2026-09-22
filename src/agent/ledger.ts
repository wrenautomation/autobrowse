/**
 * The step ledger: one hash-chained row per agent step, whatever drove it
 * (a UI session, `autobrowse agent`, a repair). What the session JSON
 * cannot answer once a worker died mid-run: how far it got, what each
 * step cost, where it was. Never a page, a value or a prompt: the model's
 * one-line thought, the act, the host, tokens and time.
 */
import { chainedFile } from "credkeep";

export interface StepRow {
  at: string;
  /** The session id, or `cli-<stamp>` for a terminal run. */
  session: string;
  site: string;
  n: number;
  /** Provider/model, from `Llm.id`. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** The act's command (`click`, `fill`, `done` …), or `invalid` when the reply did not parse. */
  cmd: string;
  ok: boolean;
  error: string | null;
  /** The whole step: observe, model, act. */
  ms: number;
  /** Where the step ran: the page URL's host, never its path. */
  host: string;
}

export interface StepLedger {
  record(row: StepRow): Promise<void>;
  /** Newest last. */
  recent(n?: number): Promise<StepRow[]>;
}

export function fileStepLedger(path: string): StepLedger {
  const file = chainedFile<StepRow>(path);
  return {
    async record(row) {
      await file.append(row);
    },
    recent: (n = 50) => file.recent(n),
  };
}

export function memoryStepLedger(): StepLedger & { rows: StepRow[] } {
  const rows: StepRow[] = [];
  return {
    rows,
    async record(row) {
      rows.push(row);
    },
    async recent(n = 50) {
      return rows.slice(-n);
    },
  };
}

export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};
