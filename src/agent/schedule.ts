/**
 * The evaluator on a clock: every so many hours, look at the evidence
 * and tell the person (through the run channels) what deserves a
 * workflow, with a line per proposal. Off unless `EVALUATE_EVERY_HOURS`
 * is set. Nothing is explored without a click; this only says.
 */
import type { Evidence, Proposal } from "./evaluator.js";

export interface ScheduleOptions {
  everyHours: number;
  evidence(): Promise<Evidence>;
  propose(evidence: Evidence): Promise<{ proposals: Proposal[] }>;
  notify(text: string): Promise<void>;
  /** Build the fresh proposals after telling about them; errors are the caller's (onError). */
  build?: (proposals: Proposal[]) => Promise<unknown>;
  /** Only proposals the last pass did not already tell about. */
  remember?: Set<string>;
  setInterval?: typeof globalThis.setInterval;
  onError?: (err: unknown) => void;
}

export function wording(proposals: Proposal[]): string | null {
  const fresh = proposals.filter((p) => !p.covered);
  if (!fresh.length) return null;
  const lines = fresh
    .slice(0, 5)
    .map((p) => `- ${p.title} (${p.occurrences}×): ${p.goal}`)
    .join("\n");
  return `autobrowse: ${fresh.length} thing${fresh.length === 1 ? "" : "s"} keep${fresh.length === 1 ? "s" : ""} needing a hand. Worth a workflow:\n${lines}\nExplore any of them from the UI.`;
}

/** One pass now, then every `everyHours`. Returns a stop function. */
export function scheduleEvaluator(o: ScheduleOptions): () => void {
  const told = o.remember ?? new Set<string>();
  // A pass can outlast the interval (builds explore sites); the next tick skips, never overlaps.
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      const { proposals } = await o.propose(await o.evidence());
      const unseen = proposals.filter((p) => !told.has(p.title));
      const text = wording(unseen);
      if (!text) return;
      for (const p of unseen) told.add(p.title);
      await o.notify(text);
      await o.build?.(unseen.filter((p) => !p.covered));
    } catch (err) {
      o.onError?.(err);
    } finally {
      running = false;
    }
  };
  void pass();
  const timer = (o.setInterval ?? setInterval)(pass, o.everyHours * 3_600_000);
  return () => clearInterval(timer);
}
