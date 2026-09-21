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
import { desktopOpSchema } from "../desktop/types.js";
import type { ExploreCommand, Explorer } from "../explore/server.js";
import { PaymentGate } from "../gates/payment.js";
import { completeJson, type Llm, LlmOutputInvalid, type LlmUsage } from "../llm/types.js";
import { type Digest, digest, hintsFor, LEGEND, pageForModel } from "./digest.js";

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
    /** Read a control's or heading's text and keep it under a name; the compiled flow reads it too. */
    z.object({ cmd: z.literal("read"), ref, as: z.string().regex(/^[a-z][a-zA-Z0-9]*$/) }),
    /** A secret the site minted goes to the sink under an env name; the model never sees it. */
    z.object({ cmd: z.literal("keep"), ref, env: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }),
    /** The goal is met (or cannot be): say what happened. */
    /** Outside the browser: an app, a menu, a key, a shell command on this machine. */
    z.object({ cmd: z.literal("os"), act: desktopOpSchema, goal: z.string() }),
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
  /**
   * The model needs a person (a captcha, money). Resolve true once they
   * have done it and the agent should go on; false (or absent) ends the run.
   */
  onHuman?: (reason: string) => Promise<boolean>;
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
Each turn you get the page URL, an outline of the page, and what your recent steps did.
The outline: containers as role "name": with their contents indented beneath; controls as [n] plus a role code and the name; several on one line separated by " · "; plain text as itself.
${LEGEND}.
"(+N more like these)" folds a long run of look-alike rows; scroll or narrow the goal to see them.
When the page is the same as last turn, the outline says so and lists only what changed; the [n] refs you saw before still apply.
Reply with ONE JSON object: {"thought": "...", "action": {...}}.
Actions, with "cmd" set to exactly one of these words:
  {"cmd":"click","ref":n,"goal":"why"}
  {"cmd":"fill","ref":n,"value":"...","goal":"why"}
  {"cmd":"select","ref":n,"value":"...","goal":"why"}
  {"cmd":"press","ref":n,"key":"Enter","goal":"why"}
  {"cmd":"upload","ref":n,"files":["path"],"goal":"why"}
  {"cmd":"open","url":"https://..."}
  {"cmd":"key","key":"Escape"}
  {"cmd":"read","ref":n,"as":"camelName"}   (keep an element's text under a name; a workflow built from this run will read it the same way)
  {"cmd":"keep","ref":n,"env":"SOME_API_KEY"}   (a key, token or password the site just minted: it goes straight to the secret store under that env name; never read or quote it)
  {"cmd":"os","act":{"op":"tree"},"goal":"why"}   (the desktop, outside the browser: the front app's controls as role "name" lines)
  {"cmd":"os","act":{"op":"open","app":"System Settings"},"goal":"why"}
  {"cmd":"os","act":{"op":"click","role":"button","name":"Allow"},"goal":"why"}   (role and name exactly as the tree printed them; "app" narrows to one app)
  {"cmd":"os","act":{"op":"type","text":"...","secret":false},"goal":"why"}   (secret:true for a password: it is then kept out of the record)
  {"cmd":"os","act":{"op":"key","combo":"cmd+q"},"goal":"why"}   (return, tab, escape, arrows, or a letter with cmd/shift/alt/ctrl)
  {"cmd":"os","act":{"op":"shell","command":"...","root":false},"goal":"why"}   (root=true only when the goal needs it; output comes back)
  {"cmd":"done","summary":"what happened","achieved":true|false}
  {"cmd":"human","reason":"why a person must do this"}
ref is the [n] of a control in the outline; only those numbers exist.
Use os acts only when the goal is outside the browser (an app, a system setting, a file, a command); look with tree before clicking.
Control names carry content too: a link named "Name Jane Doe" tells you the name is Jane Doe. When the goal asks you to report or collect something, read it with read{ref,as} first, then quote it in the done summary.
Rules: never invent values; use only the inputs given. Never buy, delete, or submit money-related forms: return human{reason} instead.
Prefer the shortest path. When the tree shows the goal is met, return done with achieved=true.
If the same step fails twice, try another element or return done with achieved=false.`;

/** Run the agent until it says done, a person says stop, or the budget runs out. */
export async function exploreWithAgent(o: AgentOptions): Promise<AgentResult> {
  const max = o.maxSteps ?? 25;
  const steps: StepRecord[] = [];
  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  let nudged = false;
  /** The page the last journaled thought was on: one note per page keeps compiled steps page-sized. */
  let notedOn: string | null = null;
  /** What the model saw last turn, to send only the change when the page is the same. */
  let seen: { url: string; page: Digest } | null = null;
  const inputs = Object.entries(o.inputs ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  for (let n = 1; n <= max; n++) {
    await o.explorer.resumed();
    if (o.stopped?.()) return { achieved: false, summary: "stopped by a person", steps, usage };
    const url = (await o.explorer.exec({ cmd: "url" })) as { url: string };
    const aria = (await o.explorer.exec({ cmd: "aria", limit: 60_000 })) as { aria: string };
    const page = digest(aria.aria, { maxRefs: o.maxRefs ?? 80 });
    const shown = pageForModel(seen?.url === url.url ? seen.page : null, page);
    seen = { url: url.url, page };
    const history = steps
      .slice(-6)
      .map((s) => `${s.n}. ${describe(s)} → ${s.error ? `FAILED: ${s.error}` : outcome(s)}`)
      .join("\n");
    const prompt = `GOAL: ${o.goal}\n${inputs ? `INPUTS:\n${inputs}\n` : ""}\nSTEP ${n} of ${max}\nURL: ${url.url}\nRECENT STEPS:\n${history || "(none)"}\n\nPAGE:\n${shown}`;
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
    // Giving up with budget left and nothing tried that failed: once, push back.
    if (step.action.cmd === "done" && !step.action.achieved && !nudged && n < max) {
      const tried = steps.some((s) => s.error);
      if (!tried) {
        nudged = true;
        rec.error = `you gave up at step ${n} of ${max} without any failed act; look at the controls again (names carry content) and try the most promising path before deciding`;
        steps.push(rec);
        o.onStep?.(rec);
        continue;
      }
    }
    if (step.action.cmd === "human" && o.onHuman) {
      await o.explorer.exec({ cmd: "note", text: `needs a person: ${step.action.reason}` });
      steps.push(rec);
      o.onStep?.(rec);
      if (await o.onHuman(step.action.reason)) continue;
      return { achieved: false, summary: step.action.reason, steps, usage };
    }
    if (step.action.cmd === "done" || step.action.cmd === "human") {
      await o.explorer.exec({ cmd: "note", text: step.thought });
      steps.push(rec);
      o.onStep?.(rec);
      const achieved = step.action.cmd === "done" && step.action.achieved;
      const summary = step.action.cmd === "done" ? step.action.summary : step.action.reason;
      return { achieved, summary, steps, usage };
    }
    if (notedOn !== url.url) {
      await o.explorer.exec({ cmd: "note", text: step.thought });
      notedOn = url.url;
    }
    try {
      rec.result = clip(await o.explorer.exec(toCommand(step.action, page)));
    } catch (err) {
      rec.error = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "failed";
      // The person said no to spending (or could not be asked): that ends the goal, not the model's turn.
      if (err instanceof PaymentGate) {
        steps.push(rec);
        o.onStep?.(rec);
        return { achieved: false, summary: err.message, steps, usage };
      }
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
  if (a.cmd === "os") return { cmd: "os", act: a.act };
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
    case "read":
      return { cmd: "read", hints, as: a.as };
    case "keep":
      return { cmd: "keep", hints, env: a.env };
  }
}

/** A step's result as kept: strings cut to what anyone reads back (a desktop tree, a command's output). */
export function clip(value: unknown, max = 6_000): unknown {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…` : value;
  if (Array.isArray(value)) return value.map((v) => clip(v, max));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v, max)]));
  return value;
}

/** What a step gave back, when it is worth the model's eyes: the text a read found. */
function outcome(s: StepRecord): string {
  const r = s.result as {
    text?: string;
    tree?: string;
    apps?: string[];
    code?: number;
    stdout?: string;
    stderr?: string;
  } | null;
  if (s.step?.action.cmd === "read" && r?.text !== undefined)
    return `ok: ${JSON.stringify(r.text.slice(0, 300))}`;
  if (s.step?.action.cmd === "os" && r) {
    if (r.tree !== undefined) return `ok, the front app shows:\n${r.tree.slice(0, 6_000)}`;
    if (r.apps) return `ok: ${r.apps.join(", ")}`;
    if (r.code !== undefined)
      return `exit ${r.code}${r.stdout ? `\n${r.stdout.slice(0, 1_500)}` : ""}${r.stderr ? `\nstderr: ${r.stderr.slice(0, 500)}` : ""}`;
  }
  return "ok";
}

function describe(s: StepRecord): string {
  if (!s.step) return "(no action)";
  const a = s.step.action;
  const at = "ref" in a ? ` [${a.ref}]` : "";
  const what =
    a.cmd === "os"
      ? ` ${a.act.op}${"name" in a.act ? ` "${a.act.name}"` : "app" in a.act && a.act.app ? ` ${a.act.app}` : "combo" in a.act ? ` ${a.act.combo}` : "command" in a.act ? ` ${a.act.command.slice(0, 60)}` : ""}`
      : a.cmd === "open"
        ? ` ${a.url}`
        : a.cmd === "fill" || a.cmd === "select"
          ? ` "${a.value}"`
          : a.cmd === "read"
            ? ` as ${a.as}`
            : a.cmd === "keep"
              ? ` as ${a.env}`
              : "";
  return `${a.cmd}${at}${what}`;
}
