/**
 * Everything the engine tells the outside. Channels render events for
 * people, the registry projects them into a run list, the UI streams
 * them. Nothing in an event is a secret: prompts, step names, paths.
 */
import type { OpenGate, RunStatus, StepResult } from "./run.js";

export interface RunRef {
  workflow: string;
  key: string;
}

export type RunEvent =
  | { type: "started"; run: RunRef; at: string }
  | { type: "step"; run: RunRef; at: string; step: string; result: StepResult }
  | { type: "gate-opened"; run: RunRef; at: string; gate: OpenGate }
  | {
      type: "gate-answered";
      run: RunRef;
      at: string;
      gate: string;
      step: string;
      approved: boolean;
      /** What the person said; a hand-off note is worth remembering. */
      note: string | null;
    }
  | { type: "paused"; run: RunRef; at: string }
  | { type: "resumed"; run: RunRef; at: string }
  | { type: "finished"; run: RunRef; at: string; status: RunStatus; summary: string }
  | { type: "reset"; run: RunRef; at: string };

export type RunEventType = RunEvent["type"];

export const runId = (ref: RunRef): string => `${ref.workflow}/${ref.key}`;
