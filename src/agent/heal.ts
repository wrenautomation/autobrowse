/**
 * Healing: a compiled flow's step failed, so the agent picks up on the page
 * where it stopped, finishes that one step, and what it did replaces the
 * step's ops in the workflow's outline. The workflow is re-rendered and
 * proven. Deterministic first, explore only at the break, deterministic
 * again after: the flow is not "agentic now", it has one step rewritten.
 *
 * A step that needs a person (captcha, purchase) stays a paused session.
 * Hand-written workflows have no outline, so they are reported, not touched.
 * Off unless AUTO_HEAL is set; `autobrowse heal <failure>` runs one by hand.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { FailureRecord } from "../browser/session.js";
import { loadOutline, saveOutline, writeRendered } from "../compiler/index.js";
import type { Outline } from "../compiler/outline.js";
import { render } from "../compiler/render.js";
import { structure } from "../compiler/structure.js";
import { loadRecording } from "../recorder/store.js";
import { repairRequest } from "./repair.js";
import type { AgentSessions, SessionView } from "./sessions.js";

export interface HealOptions {
  agent: AgentSessions;
  /** Where compiled workflows live, each with its outline.json. */
  compiledDir: string;
  recordingsDir: string;
  /** What the rendered module imports the library as. */
  lib: string;
  /** Run the healed workflow once; returns one line. Absent = no proof. */
  prove?: (workflow: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface HealOutcome {
  status: "healed" | "proof-failed" | "needs-human" | "failed" | "no-workflow";
  workflow: string | null;
  step: string | null;
  session: string | null;
  summary: string;
}

export interface Located {
  name: string;
  dir: string;
  outline: Outline;
  stepIndex: number;
}

/** Which compiled workflow owns the flow that failed: the step is named after it. */
export async function locateFailure(
  compiledDir: string,
  record: FailureRecord,
): Promise<Located | null> {
  let names: string[];
  try {
    names = readdirSync(compiledDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null;
  }
  for (const name of names) {
    const dir = join(compiledDir, name);
    let outline: Outline;
    try {
      outline = await loadOutline(dir);
    } catch {
      continue; // hand-written: no outline to heal
    }
    if (outline.site !== record.site) continue;
    const stepIndex = outline.steps.findIndex((s) => s.name === record.flow);
    if (stepIndex >= 0) return { name, dir, outline, stepIndex };
  }
  return null;
}

/** The outline with one step's ops replaced by what the repair session did. Pure. */
export function spliceStep(outline: Outline, stepIndex: number, healed: Outline): Outline {
  const step = outline.steps[stepIndex];
  if (step?.kind !== "browser") throw new Error("only a browser step can be healed");
  const ops = healed.steps.flatMap((s) => (s.kind === "browser" ? s.ops : []));
  if (ops.length === 0) throw new Error("the repair did nothing the flow could replay");
  const steps = outline.steps.map((s, i) => (i === stepIndex ? { ...step, ops } : s));
  return {
    ...outline,
    steps,
    // Fields and secrets the repair introduced (a value typed in) join the plan.
    fields: dedupe([...outline.fields, ...healed.fields], (f) => f.key),
    secrets: dedupe([...outline.secrets, ...healed.secrets], (s) => s.key),
  };
}

function dedupe<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((t) => {
    if (seen.has(key(t))) return false;
    seen.add(key(t));
    return true;
  });
}

const SETTLED = new Set<SessionView["status"]>(["done", "stopped", "failed", "closed"]);

/** A session that neither finishes nor asks for a person within this is given up on. */
const SETTLE_MS = 30 * 60_000;

async function settle(o: HealOptions, id: string): Promise<SessionView> {
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const deadline = now() + SETTLE_MS;
  for (;;) {
    const view = o.agent.get(id);
    if (!view) throw new Error(`session ${id} vanished`);
    if (SETTLED.has(view.status) || view.status === "needs-human") return view;
    if (now() >= deadline) throw new Error(`session ${id} still ${view.status} after 30 minutes`);
    await sleep(2_000);
  }
}

export async function healFailure(record: FailureRecord, o: HealOptions): Promise<HealOutcome> {
  const found = await locateFailure(o.compiledDir, record);
  if (!found) {
    return {
      status: "no-workflow",
      workflow: null,
      step: record.flow,
      session: null,
      summary: `no compiled workflow owns "${record.flow}" on ${record.site}; a hand-written flow is edited by hand`,
    };
  }
  const started = await o.agent.start(repairRequest(record));
  const view = await settle(o, started.id);
  const base = { workflow: found.name, step: record.flow, session: view.id };
  if (view.status === "needs-human") {
    return {
      ...base,
      status: "needs-human",
      summary: `the agent needs you: ${view.prompt ?? "see the session"}`,
    };
  }
  if (!(view.status === "done" && view.achieved)) {
    await o.agent.close(view.id).catch(() => undefined);
    return {
      ...base,
      status: "failed",
      summary: view.error ?? view.summary ?? `session ${view.status}`,
    };
  }
  const recName = `${found.name}-heal-${record.flow}`;
  await o.agent.save(view.id, recName);
  await o.agent.close(view.id);
  const healed = structure(await loadRecording(o.recordingsDir, recName));
  const outline = spliceStep(found.outline, found.stepIndex, healed);
  await saveOutline(found.dir, outline);
  await writeRendered(found.dir, render(outline, { lib: o.lib }));
  if (!o.prove)
    return {
      ...base,
      status: "healed",
      summary: `step "${record.flow}" rewritten from the repair; not yet proven`,
    };
  const proof = await o.prove(found.name).catch((err: Error) => `proof failed: ${err.message}`);
  const ok = proof.startsWith("proven");
  return {
    ...base,
    status: ok ? "healed" : "proof-failed",
    summary: `step "${record.flow}" rewritten from the repair; ${proof}`,
  };
}

/** One line for a message. */
export function healLine(out: HealOutcome): string {
  switch (out.status) {
    case "healed":
      return `autobrowse healed \`${out.workflow}\`: ${out.summary}`;
    case "proof-failed":
      return `autobrowse rewrote \`${out.workflow}\` step ${out.step} but the proof failed: ${out.summary}. Edit its outline.json or run heal again.`;
    case "needs-human":
      return `autobrowse could not heal \`${out.workflow}\` alone: ${out.summary}. Session ${out.session} in Explore.`;
    case "failed":
      return `autobrowse could not heal \`${out.workflow}\`: ${out.summary}`;
    case "no-workflow":
      return `autobrowse: ${out.summary}`;
  }
}
