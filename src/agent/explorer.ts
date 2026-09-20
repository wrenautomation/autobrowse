/**
 * The exploration agent: given a goal, it drives one explore session
 * itself, observe → one command → observe, until it says done. Every
 * act it makes lands in the session's journal, so what it found becomes
 * a recording and then, through the compiler, a deterministic flow. The
 * model proposes one step at a time; the code executes, bounds, and
 * records. A person can `pause` the session (over loopback), act by
 * hand or with commands, and `resume`; the agent re-observes and goes on.
 */
import { z } from "zod";
import type { ExploreCommand, Explorer } from "../explore/server.js";
import { completeJson, type Llm, LlmOutputInvalid, type LlmUsage } from "../llm/types.js";
import { type Digest, digest, hintsFor } from "./digest.js";

/** A ref number from the digest; the code turns it back into locator hints. */
const ref = z.number().int().positive();

/** What the model may do in one step: an explore act, or a verdict. */
export const stepSchema = z.object({
  /** One sentence: what the page shows and why this step. */
  thought: z.string(),
  action: z.discriminatedUnion("cmd", [
    z.object({ cmd: z.literal("open"), url: z.string().url() }),
    z.object({ cmd: z.literal("click"), ref, goal: z.string() }),
    z.object({ cmd: z.literal("fill"), ref, value: z.string(), goal: z.string() }),
    z.object({ cmd: z.literal("select"), ref, value: z.string(), goal: z.string() }),
    z.object({ cmd: z.literal("press"), ref, key: z.string(), goal: z.string() }),
    z.object({
      cmd: z.literal("upload"),
      ref,
      files: z.array(z.string()).min(1),
      goal: z.string(),
    }),
    z.object({ cmd: z.literal("key"), key: z.string() }),
    /** The goal is met (or cannot be): say what happened. */
    z.object({ cmd: z.literal("done"), summary: z.string(), achieved: z.boolean() }),
    /** Something only a person can do (a captcha, a choice with money on it). */
    z.object({ cmd: z.literal("human"), reason: z.string() }),
  ]),
});
export type Step = z.infer<typeof stepSchema>;

export interface StepRecord {
  n: number;
  /** Null when the model's reply did not parse; `error` says why. */
  step: Step | null;
  result: unknown;
  error: string | null;
  url: string;
}

export interface AgentOptions {
  explorer: Explorer;
  llm: Llm;
  goal: string;
  /** Values the goal refers to by name (a file path, a domain); the model never invents them. */
  inputs?: Record<string, string>;
  maxSteps?: number;
  /** A person said stop: the loop ends before its next step. */
  stopped?: () => boolean;
  /** Most controls the model sees per step. */
  maxRefs?: number;
  onStep?: (r: StepRecord) => void;
}

export interface AgentResult {
  achieved: boolean;
  summary: string;
  steps: StepRecord[];
  usage: LlmUsage;
}

const SYSTEM = `You drive a real web browser to reach a goal, one step at a time.
Each turn you get the page URL, a digest of the page (controls as [n] role "name", plus headings and text), and what your recent steps did.
Reply with ONE JSON object: {"thought": "...", "action": {...}}.
Actions, with "cmd" set to exactly one of these words:
  {"cmd":"click","ref":n,"goal":"why"}
  {"cmd":"fill","ref":n,"value":"...","goal":"why"}
  {"cmd":"select","ref":n,"value":"...","goal":"why"}
  {"cmd":"press","ref":n,"key":"Enter","goal":"why"}
  {"cmd":"upload","ref":n,"files":["path"],"goal":"why"}
  {"cmd":"open","url":"https://..."}
  {"cmd":"key","key":"Escape"}
  {"cmd":"done","summary":"what happened","achieved":true|false}
  {"cmd":"human","reason":"why a person must do this"}
ref is the [n] of a control in the digest; only those numbers exist.
Control names carry content too: a link named "Name Jane Doe" tells you the name is Jane Doe. When the goal asks you to report something, quote it in the done summary.
Rules: never invent values; use only the inputs given. Never buy, delete, or submit money-related forms: return human{reason} instead.
Prefer the shortest path. When the tree shows the goal is met, return done with achieved=true.
If the same step fails twice, try another element or return done with achieved=false.`;

/** Run the agent until it says done, a person says stop, or the budget runs out. */
export async function exploreWithAgent(o: AgentOptions): Promise<AgentResult> {
  const max = o.maxSteps ?? 25;
  const steps: StepRecord[] = [];
  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  const inputs = Object.entries(o.inputs ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  for (let n = 1; n <= max; n++) {
    await o.explorer.resumed();
    if (o.stopped?.()) return { achieved: false, summary: "stopped by a person", steps, usage };
    const url = (await o.explorer.exec({ cmd: "url" })) as { url: string };
    const aria = (await o.explorer.exec({ cmd: "aria", limit: 60_000 })) as { aria: string };
    const page = digest(aria.aria, { maxRefs: o.maxRefs ?? 80 });
    const history = steps
      .slice(-6)
      .map((s) => `${s.n}. ${describe(s)} → ${s.error ? `FAILED: ${s.error}` : "ok"}`)
      .join("\n");
    const prompt = `GOAL: ${o.goal}\n${inputs ? `INPUTS:\n${inputs}\n` : ""}\nSTEP ${n} of ${max}\nURL: ${url.url}\nRECENT STEPS:\n${history || "(none)"}\n\nPAGE:\n${page.text}`;
    let step: Step;
    try {
      const reply = await completeJson(o.llm, stepSchema, {
        system: SYSTEM,
        prompt,
        maxTokens: 600,
      });
      usage.inputTokens += reply.usage.inputTokens;
      usage.outputTokens += reply.usage.outputTokens;
      step = reply.value;
    } catch (err) {
      if (!(err instanceof LlmOutputInvalid)) throw err;
      // A malformed reply is a failed step the model sees next turn, not the end of the run.
      const rec: StepRecord = {
        n,
        step: null,
        result: null,
        error: `your reply was not a valid action (${err.issues})`,
        url: url.url,
      };
      steps.push(rec);
      o.onStep?.(rec);
      continue;
    }
    const rec: StepRecord = { n, step, result: null, error: null, url: url.url };
    if (step.action.cmd === "done" || step.action.cmd === "human") {
      await o.explorer.exec({ cmd: "note", text: step.thought });
      steps.push(rec);
      o.onStep?.(rec);
      const achieved = step.action.cmd === "done" && step.action.achieved;
      const summary = step.action.cmd === "done" ? step.action.summary : step.action.reason;
      return { achieved, summary, steps, usage };
    }
    await o.explorer.exec({ cmd: "note", text: step.thought });
    try {
      rec.result = await o.explorer.exec(toCommand(step.action, page));
    } catch (err) {
      rec.error = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "failed";
    }
    steps.push(rec);
    o.onStep?.(rec);
  }
  return { achieved: false, summary: `no verdict after ${max} steps`, steps, usage };
}

type Act = Exclude<Step["action"], { cmd: "done" } | { cmd: "human" }>;

/** The model's step as an explore command; a ref must be one the digest listed. */
function toCommand(a: Act, page: Digest): ExploreCommand {
  if (a.cmd === "open") return { cmd: "open", url: a.url };
  if (a.cmd === "key") return { cmd: "key", key: a.key };
  const ref = page.refs.find((r) => r.n === a.ref);
  if (!ref) throw new Error(`ref ${a.ref} is not on the page; refs go 1..${page.refs.length}`);
  const hints = hintsFor(ref);
  switch (a.cmd) {
    case "click":
      return { cmd: "click", hints, goal: a.goal };
    case "fill":
      return { cmd: "fill", hints, value: a.value, goal: a.goal };
    case "select":
      return { cmd: "select", hints, value: a.value, goal: a.goal };
    case "press":
      return { cmd: "press", hints, key: a.key, goal: a.goal };
    case "upload":
      return { cmd: "upload", hints, files: a.files, goal: a.goal };
  }
}

function describe(s: StepRecord): string {
  if (!s.step) return "(no action)";
  const a = s.step.action;
  const at = "ref" in a ? ` [${a.ref}]` : "";
  const what =
    a.cmd === "open" ? ` ${a.url}` : a.cmd === "fill" || a.cmd === "select" ? ` "${a.value}"` : "";
  return `${a.cmd}${at}${what}`;
}
