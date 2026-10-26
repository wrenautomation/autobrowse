/**
 * A run as training steps (designs/2026-10-26-run-observations.md): the autotrack outline
 * (episode, step, obs, action, next, out) for a browser run. Texts and pictures are named by
 * hash: the trainer reads them from the bucket (`<run>.obs.*.jsonl.zst`, `blobs/<hash>.jpg`).
 * Pure over the run's rows, so a rule change reruns over every old run.
 */
import { redactText } from "../recorder/redact.js";
import type { Action } from "../recorder/types.js";
import type { MissCause, RunOutcome, RunRow } from "./log.js";

export interface RunStep {
  /** The run id. */
  episode: string;
  site: string;
  goal?: string;
  /** 0-based within the run. */
  step: number;
  at: string;
  /** The Claude Code session that sent it: the link to the model's own reasoning. */
  session?: string;
  obs: {
    /** The last text the caller read before it chose: an answer, or the page after an act. */
    text?: string;
    /** Pictures taken before the act: a new screen, a marks shot. */
    frames?: string[];
    /** A marks shot's boxes, CSS px, in mark order. */
    boxes?: Array<[number, number, number, number]>;
    url?: string;
    landmarks?: string[];
  };
  action: { cmd: string; act?: Action; hand?: true };
  /** What came of it: the page after the act, else the answer. */
  next: { text?: string };
  out: { ok: boolean; error?: string; miss?: MissCause; ms?: number };
  /** How the run ended: the episode's label. Absent while it is open. */
  outcome?: RunOutcome;
}

/** Typed text masked like every stored answer: a token pasted into a field stays out. */
const masked = (act: Action): Action => {
  const a = act as Action & { value?: unknown; text?: unknown };
  return {
    ...a,
    ...(typeof a.value === "string" ? { value: redactText(a.value) } : {}),
    ...(typeof a.text === "string" ? { text: redactText(a.text) } : {}),
  } as Action;
};

export function runSteps(rows: RunRow[]): RunStep[] {
  const out: RunStep[] = [];
  let run = "";
  let site = "";
  let goal: string | undefined;
  let session: string | undefined;
  let seen: string | undefined;
  let acts: Extract<RunRow, { kind: "act" }>[] = [];
  const head = () => ({
    episode: run,
    site,
    ...(goal ? { goal } : {}),
    step: out.length,
    ...(session ? { session } : {}),
  });
  for (const r of rows) {
    if (r.kind === "start") {
      run = r.run;
      site = r.site;
      goal = r.goal ?? goal;
      session = r.session ?? session;
    } else if (r.kind === "goal") goal = r.goal;
    else if (r.kind === "act") {
      if (!r.hand) {
        acts.push(r);
        continue;
      }
      // A person's act between commands: a step with no answer of its own.
      out.push({
        ...head(),
        at: r.at,
        obs: {
          ...(seen ? { text: seen } : {}),
          ...(r.look ? { url: r.look.url, landmarks: r.look.landmarks } : {}),
        },
        action: { cmd: "hand", act: masked(r.act), hand: true },
        next: {},
        out: { ok: true },
      });
    } else if (r.kind === "cmd") {
      if (r.session) session = r.session;
      const act = acts.at(-1);
      acts = [];
      const next = r.after ?? r.obs;
      out.push({
        ...head(),
        at: r.at,
        obs: {
          ...(seen ? { text: seen } : {}),
          ...(r.pics ? { frames: r.pics } : {}),
          ...(r.boxes ? { boxes: r.boxes } : {}),
          ...(act?.look ? { url: act.look.url, landmarks: act.look.landmarks } : {}),
        },
        action: { cmd: r.cmd, ...(act ? { act: masked(act.act) } : {}) },
        next: next ? { text: next } : {},
        out: {
          ok: r.ok,
          ms: r.ms,
          ...(r.error ? { error: r.error } : {}),
          ...(r.miss ? { miss: r.miss } : {}),
        },
      });
      if (next) seen = next;
    } else if (r.kind === "end") {
      // Each life ends once: its steps since the last end take its outcome.
      for (const s of out) if (s.outcome === undefined) s.outcome = r.outcome;
    }
  }
  return out;
}
