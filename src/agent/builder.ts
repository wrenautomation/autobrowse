/**
 * The last leg of self-building: a proposal the evaluator ranked becomes a
 * workflow with nobody clicking. The agent explores the goal once; what it
 * achieved is saved as a recording and compiled; the person hears what got
 * built, or where the agent stopped so they can take over in the UI.
 * Off unless AUTO_BUILD is set: guards still hold inside the session, so
 * a purchase or a password still waits for a person.
 */
import type { Proposal } from "./evaluator.js";
import type { AgentSessions, SessionView } from "./sessions.js";

export interface BuilderOptions {
  agent: AgentSessions;
  /** Compile the recording saved under `name`; returns the workflow's name. */
  compile(name: string): Promise<{ workflow: string }>;
  /** Run the compiled workflow once and keep the outcome beside it; returns one line. Absent = no proof run. */
  prove?: (workflow: string) => Promise<string>;
  notify(text: string): Promise<void>;
  /** A proposal needs this much evidence before the agent spends a session on it. */
  minOccurrences?: number;
  /** At most this many builds per pass; the rest wait for the next one. */
  perPass?: number;
  /** Titles already built or attempted; kept by the caller across passes. */
  remember?: Set<string>;
  sleep?: (ms: number) => Promise<void>;
}

export interface BuildOutcome {
  title: string;
  session: string;
  /** The compiled workflow's name, or null when the agent did not get there. */
  workflow: string | null;
  summary: string;
}

const SETTLED = new Set<SessionView["status"]>(["done", "stopped", "failed", "closed"]);

/** `Title Of Thing` → `title-of-thing`, bounded. */
export function recordingNameFor(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "") || "proposal"
  );
}

/** Which proposals this pass builds: fresh, evidenced, not seen before. */
export function pickBuildable(proposals: Proposal[], o: BuilderOptions): Proposal[] {
  const min = o.minOccurrences ?? 2;
  const seen = o.remember ?? new Set<string>();
  return proposals
    .filter((p) => !p.covered && p.occurrences >= min && !seen.has(p.title))
    .slice(0, o.perPass ?? 1);
}

/** Wait for the session to settle or to ask for a person. */
async function settle(o: BuilderOptions, id: string): Promise<SessionView> {
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    const view = o.agent.get(id);
    if (!view) throw new Error(`session ${id} vanished`);
    if (SETTLED.has(view.status) || view.status === "needs-human") return view;
    await sleep(2_000);
  }
}

export async function buildProposals(
  proposals: Proposal[],
  o: BuilderOptions,
): Promise<BuildOutcome[]> {
  const seen = o.remember ?? new Set<string>();
  const outcomes: BuildOutcome[] = [];
  for (const p of pickBuildable(proposals, o)) {
    seen.add(p.title);
    const started = await o.agent.start({ site: p.site, goal: p.goal });
    const view = await settle(o, started.id);
    let outcome: BuildOutcome;
    if (view.status === "needs-human") {
      // The session stays open, paused on the person's prompt: theirs to finish in the UI.
      outcome = {
        title: p.title,
        session: view.id,
        workflow: null,
        summary: `the agent needs you: ${view.prompt ?? "see the session"}`,
      };
    } else if (view.status === "done" && view.achieved) {
      const name = recordingNameFor(p.title);
      await o.agent.save(view.id, name);
      await o.agent.close(view.id);
      const { workflow } = await o.compile(name);
      // The recording worked once by hand; the proof is the compiled flow working on its own.
      const proof = o.prove
        ? await o.prove(workflow).catch((err: Error) => `proof failed: ${err.message}`)
        : null;
      outcome = {
        title: p.title,
        session: view.id,
        workflow,
        summary: proof ? `${view.summary ?? ""}; ${proof}` : (view.summary ?? ""),
      };
    } else {
      await o.agent.close(view.id).catch(() => undefined);
      outcome = {
        title: p.title,
        session: view.id,
        workflow: null,
        summary: view.error ?? view.summary ?? `session ${view.status}`,
      };
    }
    outcomes.push(outcome);
    await o
      .notify(
        outcome.workflow
          ? `autobrowse built \`${outcome.workflow}\` from "${p.title}": ${outcome.summary}. It is on the Runs page.`
          : `autobrowse could not build "${p.title}" on its own: ${outcome.summary}. Session ${outcome.session} in Explore.`,
      )
      .catch(() => undefined);
  }
  return outcomes;
}
