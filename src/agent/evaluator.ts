/**
 * The evaluator: what keeps going wrong or keeps being done by hand,
 * and which of it deserves a durable workflow. Evidence in: failure
 * records, agent sessions (with their verdicts), recordings on disk.
 * Proposals out: a site and a goal each, one click from an agent
 * session. The model ranks and words; the code gathers and bounds.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { FailureRecord } from "../browser/session.js";
import { completeJson, type Llm, type LlmUsage } from "../llm/types.js";
import type { SessionView } from "./sessions.js";

export const proposalSchema = z.object({
  title: z.string(),
  /** One or two sentences: the evidence and why a flow pays off. */
  why: z.string(),
  site: z.string(),
  /** The goal to hand an agent, complete enough to run as is. */
  goal: z.string(),
  /** How many times the evidence shows the need. */
  occurrences: z.number().int().nonnegative(),
  /** Already covered by a recording or flow: keep for the record, do not build again. */
  covered: z.boolean(),
});
export type Proposal = z.infer<typeof proposalSchema>;
const proposalsSchema = z.object({ proposals: z.array(proposalSchema).max(10) });

export interface Evidence {
  failures: FailureRecord[];
  sessions: Pick<
    SessionView,
    "site" | "goal" | "status" | "achieved" | "summary" | "recordingName"
  >[];
  recordings: Array<{ name: string; site: string }>;
  /** What can already run, hand-written or compiled: the other half of "covered". */
  workflows?: Array<{ name: string; description: string }>;
}

/** Every `*.failure.json` under the artifacts dir, newest first, capped. */
export async function readFailures(artifactsDir: string, limit = 50): Promise<FailureRecord[]> {
  let names: string[];
  try {
    names = (await readdir(artifactsDir)).filter((f) => f.endsWith(".failure.json"));
  } catch {
    return [];
  }
  const records = (
    await Promise.all(
      names.map(async (f) => {
        try {
          return JSON.parse(await readFile(join(artifactsDir, f), "utf8")) as FailureRecord;
        } catch {
          return null; // a half-written or foreign file is not evidence
        }
      }),
    )
  ).filter((r): r is FailureRecord => r !== null);
  return records.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

const SYSTEM = `You look at what a browser-automation system has been failing at or doing by hand, and say which recurring needs deserve a durable, deterministic workflow.
Reply with ONE JSON object: {"proposals": [{"title", "why", "site", "goal", "occurrences", "covered"}]}.
Group evidence by the underlying need (the same login wall on three flows is one need). Rank by occurrences × cost of doing it by hand.
"goal" must be runnable by an agent as written: name the site page and the outcome, no placeholders.
"covered" is true when a recording or a workflow that already runs does it. At most 10 proposals; none when the evidence shows nothing recurring.
Browser workflows are for what has no API. When the need is served by a documented API (DNS records, creating users, sending mail), do not propose a browser workflow; if it is the only recurring thing, propose it once with "why" saying an API path exists.`;

export function describeEvidence(e: Evidence): string {
  const failures = e.failures
    .map(
      (f) =>
        `- ${f.site}/${f.flow} ${f.kind} at ${f.url}${f.goal ? ` doing "${f.goal}"` : ""}: ${f.error.slice(0, 160)}`,
    )
    .join("\n");
  const sessions = e.sessions
    .map(
      (s) =>
        `- ${s.site}: "${s.goal}" → ${s.status}${s.achieved === null ? "" : s.achieved ? ", achieved" : ", not achieved"}${s.summary ? `: ${s.summary.slice(0, 160)}` : ""}${s.recordingName ? ` (saved as ${s.recordingName})` : ""}`,
    )
    .join("\n");
  const recordings = e.recordings.map((r) => `- ${r.name} (${r.site})`).join("\n");
  const workflows = (e.workflows ?? []).map((w) => `- ${w.name}: ${w.description}`).join("\n");
  return `FLOW FAILURES (${e.failures.length}):\n${failures || "(none)"}\n\nAGENT SESSIONS (${e.sessions.length}):\n${sessions || "(none)"}\n\nRECORDINGS ON DISK (${e.recordings.length}):\n${recordings || "(none)"}\n\nWORKFLOWS THAT ALREADY RUN (${e.workflows?.length ?? 0}):\n${workflows || "(none)"}`;
}

export async function proposeWorkflows(
  llm: Llm,
  evidence: Evidence,
): Promise<{ proposals: Proposal[]; usage: LlmUsage }> {
  const empty = evidence.failures.length === 0 && evidence.sessions.length === 0;
  if (empty) return { proposals: [], usage: { inputTokens: 0, outputTokens: 0 } };
  const { value, usage } = await completeJson(llm, proposalsSchema, {
    system: SYSTEM,
    prompt: describeEvidence(evidence),
    maxTokens: 1500,
  });
  return { proposals: value.proposals.sort((a, b) => b.occurrences - a.occurrences), usage };
}
