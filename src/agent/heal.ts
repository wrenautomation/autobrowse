/**
 * Healing: a compiled flow's act broke and neither the kept fix nor the
 * repairer found the control (the page changed shape: a new screen, a step
 * moved). The agent picks up on the page where it stopped and does that one
 * act, nothing more. What it did replaces that one op in the outline, and
 * that one statement in the module's source; every other op, and the
 * model's earlier finish, stay as they were. Then the workflow is proven.
 * If the next op is broken too, the proof fails there and heals that one:
 * micro-patches, never a re-explore of the whole flow.
 *
 * Only when the source no longer shows the op plainly (the finish reshaped
 * it) or the repair typed a new plan value is the module re-rendered and
 * finished again. A step that needs a person (captcha, purchase) stays a
 * paused session. Hand-written workflows have no outline, so they are
 * reported, not touched. Off unless AUTO_HEAL is set; `autobrowse heal
 * <failure>` runs one by hand.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Fix, type Fixes, flowKey } from "../browser/fixes.js";
import type { FailureRecord } from "../browser/session.js";
import { MODULE_FILE } from "../compiler/finish.js";
import {
  type FinishOutcome,
  format,
  loadOutline,
  rerender,
  saveOutline,
} from "../compiler/index.js";
import type { Outline, OutlineOp } from "../compiler/outline.js";
import { brokenOp, replaceOp } from "../compiler/patch.js";
import { structure } from "../compiler/structure.js";
import { redactText } from "../recorder/redact.js";
import { loadRecording } from "../recorder/store.js";
import type { AgentSessions, SessionView, StartRequest } from "./sessions.js";

export interface HealOptions {
  agent: AgentSessions;
  /** Where compiled workflows live, each with its outline.json. */
  compiledDir: string;
  recordingsDir: string;
  /** What the rendered module imports the library as. */
  lib: string;
  /** Run the healed workflow once; returns one line. Absent = no proof. */
  prove?: (workflow: string) => Promise<string>;
  /** After the re-render: the model's finish (plan inputs, gates, proof reads) under tsc+vitest. Absent = template output stands. */
  finish?: (workflow: string, step: string) => Promise<FinishOutcome>;
  /** Typecheck and test a workflow's directory; null when both pass. A patched source must pass it or the heal re-renders. */
  check?: (dir: string) => Promise<string | null>;
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
  /** The op that broke; null when the record does not say which. */
  opIndex: number | null;
}

/** Which compiled workflow owns the flow that failed: the step is named after it. */
export async function locateFailure(
  compiledDir: string,
  record: FailureRecord,
): Promise<Located | null> {
  let names: string[];
  try {
    names = (await readdir(compiledDir, { withFileTypes: true }))
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
    const step = outline.steps[stepIndex];
    if (step?.kind !== "browser") continue;
    const opIndex = brokenOp(step, record.hints, record.goal, record.actsBefore);
    return { name, dir, outline, stepIndex, opIndex };
  }
  return null;
}

/** The agent's goal: the one act, not the rest of the flow. */
export function healRequest(
  record: FailureRecord,
  op: Exclude<OutlineOp, { kind: "human" }>,
): StartRequest {
  return {
    site: record.site,
    url: record.url,
    goal:
      `Do only this one act of the flow "${record.flow}": "${op.goal}". ` +
      `Its locator no longer finds the control; the flow stopped here with: ${redactText(record.error)}. ` +
      "Stop as soon as that act is done: the flow does the rest.",
  };
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
  const step = found.outline.steps[found.stepIndex];
  const op = found.opIndex === null || step?.kind !== "browser" ? null : step.ops[found.opIndex];
  if (!op || op.kind === "human" || found.opIndex === null) {
    return {
      status: "failed",
      workflow: found.name,
      step: record.flow,
      session: null,
      summary: `can't tell which act of "${record.flow}" broke, so nothing was rewritten; \`autobrowse repair\` the failure by hand`,
    };
  }
  const opIndex = found.opIndex;
  const started = await o.agent.start(healRequest(record, op));
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
  const ops = healed.steps.flatMap((s) => (s.kind === "browser" ? s.ops : []));
  const moduleFile = join(found.dir, MODULE_FILE);
  // No module yet (never rendered): nothing to patch, so it renders.
  const before = await readFile(moduleFile, "utf8").catch(() => null);
  const mended = replaceOp(found.outline, before ?? "", found.stepIndex, opIndex, {
    ops,
    fields: healed.fields,
    secrets: healed.secrets,
  });
  const what = `op ${opIndex + 1} of "${record.flow}" ("${op.goal}") replaced by ${ops.length} op${ops.length === 1 ? "" : "s"}`;
  let how: string | null = null;
  if (mended.source !== null && before !== null) {
    await writeFile(moduleFile, mended.source);
    await format([moduleFile]);
    const broken = o.check ? await o.check(found.dir).catch((err: Error) => err.message) : null;
    if (broken === null) {
      await saveOutline(found.dir, mended.outline);
      how = "patched in place, no model";
    } else await writeFile(moduleFile, before);
  }
  if (how === null) {
    // The source can't take a one-line patch: re-render, and the model finishes it again.
    await rerender(found.dir, mended.outline, { lib: o.lib });
    const finished = o.finish
      ? await o.finish(found.name, record.flow).catch((err: Error) => ({
          status: "gave-up" as const,
          rounds: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
          summary: err.message,
        }))
      : null;
    how = `re-rendered${finished ? `, ${finished.status === "finished" ? "finished" : finished.status} by the model` : ""}`;
  }
  const rewritten = `${what}; ${how}`;
  if (!o.prove) return { ...base, status: "healed", summary: `${rewritten}; not yet proven` };
  const proof = await o.prove(found.name).catch((err: Error) => `proof failed: ${err.message}`);
  const ok = proof.startsWith("proven");
  return {
    ...base,
    status: ok ? "healed" : "proof-failed",
    summary: `${rewritten}; ${proof}`,
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

export interface Applied {
  /** `workflow: goal` per fix written in. */
  applied: string[];
  /** Workflows whose source could not take the patch and were re-rendered (run `compile --finish` on them). */
  rendered: string[];
}

/**
 * Kept fixes written into the compiled workflows they belong to: one
 * statement each (a detour becomes its clicks, then the op), no model, and
 * the fix is dropped once the source says the same. Fixes for hand-written
 * flows, or ones whose op can't be pinned, stay listed for a person.
 */
export async function applyFixes(compiledDir: string, fixes: Fixes, lib: string): Promise<Applied> {
  const out: Applied = { applied: [], rendered: [] };
  let names: string[];
  try {
    names = (await readdir(compiledDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }
  // By flow once: each step looks up its own fixes instead of scanning them all.
  const byFlow = new Map<string, Fix[]>();
  for (const f of fixes.list()) {
    const list = byFlow.get(f.flow);
    if (list) list.push(f);
    else byFlow.set(f.flow, [f]);
  }
  for (const name of names) {
    const dir = join(compiledDir, name);
    let outline: Outline;
    try {
      outline = await loadOutline(dir);
    } catch {
      continue;
    }
    const moduleFile = join(dir, MODULE_FILE);
    let source: string | null = await readFile(moduleFile, "utf8").catch(() => null);
    let render = source === null;
    const done: Fix[] = [];
    for (const [si, step] of outline.steps.entries()) {
      if (step.kind !== "browser") continue;
      const key = flowKey(outline.site, step.name);
      // Last op first: an earlier fix that adds detour clicks would shift the later ones.
      const pinned = (byFlow.get(key) ?? [])
        .map((f) => ({ f, at: brokenOp(step, f.failed, f.goal) }))
        .filter((p): p is { f: Fix; at: number } => p.at !== null)
        .sort((a, b) => b.at - a.at);
      for (const { f, at } of pinned) {
        const op = step.ops[at];
        if (!op || op.kind === "human") continue;
        const ops: OutlineOp[] = [
          ...(f.detours ?? []).map((hints) => ({
            kind: "click" as const,
            goal: `get past ${hints.name ?? hints.text ?? "the screen in the way"}`,
            hints,
            irreversible: false,
          })),
          { ...op, hints: f.hints },
        ];
        const mended = replaceOp(outline, source ?? "", si, at, { ops });
        outline = mended.outline;
        if (mended.source === null) render = true;
        else source = mended.source;
        done.push(f);
      }
    }
    if (!done.length) continue;
    if (render) {
      await rerender(dir, outline, { lib });
      out.rendered.push(name);
    } else {
      await writeFile(moduleFile, source as string);
      await format([moduleFile]);
      await saveOutline(dir, outline);
    }
    for (const f of done) {
      fixes.drop(f.flow, f.goal, f.failed);
      out.applied.push(`${name}: ${f.goal}`);
    }
  }
  return out;
}
