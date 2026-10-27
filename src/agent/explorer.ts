/**
 * The exploration agent: given a goal, it drives one explore session
 * itself, observe → a few commands → observe, until it says done. Every
 * act it makes lands in the session's journal, so what it found becomes
 * a recording and then, through the compiler, a deterministic flow. The
 * model plans the acts for one screen (a batch); the code executes,
 * bounds, and records, and ends a batch early when the page moves. A
 * person can `pause` the session (over loopback), act by hand or with
 * commands, and `resume`; the agent re-observes and goes on.
 */
import { z } from "zod";
import type { Extra } from "../browser/extras.js";
import { desktopOpSchema } from "../desktop/types.js";
import type { ExploreCommand, Explorer } from "../explore/server.js";
import { PaymentGate } from "../gates/payment.js";
import { withTrace } from "../llm/trace.js";
import { completeJson, type Llm, LlmOutputInvalid, type LlmUsage } from "../llm/types.js";
import { type Digest, digest, hintsFor, LEGEND } from "./digest.js";
import { hostOf, type StepLedger } from "./ledger.js";

/** A ref number from the digest; the code turns it back into locator hints. */
const ref = z.number().int().positive();

/** One act the model may plan: an explore act, or a verdict. */
const actionSchema = z.discriminatedUnion("cmd", [
  z.object({ cmd: z.literal("open"), url: z.string().url() }),
  z.object({ cmd: z.literal("click"), ref, goal: z.string() }),
  z.object({ cmd: z.literal("fill"), ref, value: z.string(), goal: z.string() }),
  /** A named secret into a field: the code fills it, the model never sees it. */
  z.object({ cmd: z.literal("place"), ref, secret: z.string().min(1), goal: z.string() }),
  z.object({ cmd: z.literal("select"), ref, value: z.string(), goal: z.string() }),
  z.object({ cmd: z.literal("press"), ref, key: z.string(), goal: z.string() }),
  z.object({
    cmd: z.literal("upload"),
    ref,
    files: z.array(z.string()).min(1),
    goal: z.string(),
  }),
  z.object({ cmd: z.literal("key"), key: z.string() }),
  /** Any captcha on the page: solved by the hands and, for a picture, a model that sees. */
  z.object({ cmd: z.literal("captcha") }),
  /** Read a control's or heading's text and keep it under a name; the compiled flow reads it too. */
  z.object({ cmd: z.literal("read"), ref, as: z.string().regex(/^[a-z][a-zA-Z0-9]*$/) }),
  /** A list on the page as rows: the session writes an extractor once; the compiled flow reruns it. */
  z.object({
    cmd: z.literal("records"),
    as: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
    goal: z.string().min(1),
    fields: z
      .array(z.object({ key: z.string().regex(/^[a-z][a-zA-Z0-9]*$/), says: z.string() }))
      .min(1),
    max: z.number().int().positive().optional(),
  }),
  /** A secret the site minted goes to the sink under an env name; the model never sees it. */
  z.object({ cmd: z.literal("keep"), ref, env: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }),
  /** The goal is met (or cannot be): say what happened. */
  /** Outside the browser: an app, a menu, a key, a shell command on this machine. */
  z.object({ cmd: z.literal("os"), act: desktopOpSchema, goal: z.string() }),
  z.object({ cmd: z.literal("done"), summary: z.string(), achieved: z.boolean() }),
  /** Something only a person can do (a captcha, a choice with money on it). */
  z.object({ cmd: z.literal("human"), reason: z.string() }),
]);

/** One step as kept: the batch's thought and one act. */
export const stepSchema = z.object({
  /** One sentence: what the page shows and why this step. */
  thought: z.string(),
  action: actionSchema,
});
export type Step = z.infer<typeof stepSchema>;

/**
 * What the model replies: a thought and the acts for one screen. A lone `action` is a plan of one.
 * A `done` after other acts is dropped: the acts run, and the model judges the page they leave.
 */
export const planSchema = z.preprocess(
  (v) => {
    const plan =
      v && typeof v === "object" && !("actions" in v) && "action" in v
        ? { ...v, actions: [(v as { action: unknown }).action] }
        : v;
    if (!plan || typeof plan !== "object" || !("actions" in plan)) return plan;
    const acts = (plan as { actions: unknown }).actions;
    const last = Array.isArray(acts) ? (acts.at(-1) as { cmd?: unknown } | undefined) : undefined;
    return Array.isArray(acts) && acts.length > 1 && last?.cmd === "done"
      ? { ...plan, actions: acts.slice(0, -1) }
      : plan;
  },
  z
    .object({ thought: z.string(), actions: z.array(actionSchema).min(1) })
    .refine(
      (p) =>
        p.actions.length === 1 || !p.actions.some((a) => a.cmd === "done" || a.cmd === "human"),
      { message: "done and human must be the only action in their reply", path: ["actions"] },
    ),
);
export type Plan = z.infer<typeof planSchema>;

/** Why a batch ended before its last act: the code saw the page move. */
export type Miss = "gone" | "navigated" | "dialog" | "invalid" | "error";

export interface StepRecord {
  n: number;
  /** Null when the model's reply did not parse; `error` says why. */
  step: Step | null;
  result: unknown;
  error: string | null;
  url: string;
  /** This step's model spend and wall time (observe, model, act); a batch's spend is on its first act. */
  usage: LlmUsage;
  ms: number;
  /** The step number of the batch's first act: one model call. */
  batch: number;
  /** Set when the batch ended after this act with acts left: why. */
  missed: Miss | null;
}

export interface AgentOptions {
  explorer: Explorer;
  llm: Llm;
  goal: string;
  /** Values the goal refers to by name (a file path, a domain); the model never invents them. */
  inputs?: Record<string, string>;
  /** Names the model may `place` into fields (a password, a code); the values stay in the explorer. */
  secrets?: readonly string[];
  maxSteps?: number;
  /** Where every step lands as a row (`~/.config/autobrowse/steps.jsonl`); `session` names the run there. */
  ledger?: StepLedger;
  session?: string;
  /** Steps a session that died already took: seen as this run's own, counted on from. */
  prior?: readonly StepRecord[];
  site?: string;
  /** A person said stop: the loop ends before its next step. */
  stopped?: () => boolean;
  /**
   * The model needs a person (a captcha, money). Resolve true once they
   * have done it and the agent should go on; false (or absent) ends the run.
   */
  onHuman?: (reason: string) => Promise<boolean>;
  /** Most controls the model sees per step. */
  maxRefs?: number;
  /** Most acts one model call may plan for one screen (6); at 1, one act per call. */
  maxBatch?: number;
  onStep?: (r: StepRecord) => void;
}

export interface AgentResult {
  achieved: boolean;
  summary: string;
  steps: StepRecord[];
  usage: LlmUsage;
}

/** How a plan of several acts may look: the code holds to the same rules. */
const BATCH = `Plan several actions only for the screen you see now.
These may come before other actions: fill, place, select, upload, read, records, and a click on a C, R, O, S, TAB or X ref.
Any other action runs last, and the code skips the actions after it: a click on a button or link, press, open, key, captcha, keep, os.
Put done or human alone in their reply.
The code stops a plan early when a target is gone, the URL changes, a dialog opens, or an error shows. Then you see the page again and the actions that did not run.`;

/** The system prompt; `maxBatch` above 1 adds the batch rules. */
const systemFor = (
  maxBatch: number,
) => `You drive a real web browser to reach a goal, a few steps at a time.
Each turn you get the page URL, an outline of the page, and what your recent steps did.
The outline: containers as role "name": with their contents indented beneath; controls as [n] plus a role code and the name; several on one line separated by " · "; plain text as itself.
${LEGEND}.
"(+N more like these)" folds a long run of look-alike rows; scroll or narrow the goal to see them.
When the page is the same as last turn, the outline says so and lists only what changed; the [n] refs you saw before still apply.
Reply with ONE JSON object: {"thought": "...", "actions": [{...}]}, ${maxBatch > 1 ? `1 to ${maxBatch} actions, run in order` : "exactly one action"}.
Actions, with "cmd" set to exactly one of these words:
  {"cmd":"click","ref":n,"goal":"why"}
  {"cmd":"fill","ref":n,"value":"...","goal":"why"}
  {"cmd":"place","ref":n,"secret":"name","goal":"why"}   (a SECRET by its name goes into the field; you never see or type its value)
  {"cmd":"select","ref":n,"value":"...","goal":"why"}
  {"cmd":"press","ref":n,"key":"Enter","goal":"why"}
  {"cmd":"upload","ref":n,"files":["path"],"goal":"why"}   ("file:<name>" for a stored file by its name)
  {"cmd":"open","url":"https://..."}
  {"cmd":"key","key":"Escape"}
  {"cmd":"captcha"}   (solve the captcha on the page, any kind; says solved or why not)
  {"cmd":"read","ref":n,"as":"camelName"}   (keep an element's text under a name; a workflow built from this run will read it the same way)
  {"cmd":"records","as":"camelName","goal":"what the rows are","fields":[{"key":"title","says":"what it holds"}],"max":10}   (a list on the page as rows; a workflow built from this run reads the list again, whatever it holds then)
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
Control names carry content too: a link named "Name Jane Doe" tells you the name is Jane Doe. When the goal asks you to report or collect something, read it with read{ref,as} first, then quote it in the done summary. For a list (results, rows, items), use one records act, never one read per item: a read finds its element by the text it shows, so it finds only that same text again. Name a records or read "as" for what it holds ("stories", "price"), never after the values you typed: a workflow built from this run fills in other values.
An "iframe:" section is a frame inside the page (a captcha, an embedded sign-in); its refs work like any other.
A "not in the tree:" section lists controls the outline misses (inside a closed web component, or a card clickable only by script); click or fill them like any other ref.
Rules: never invent values; use only the inputs given. Never buy, delete, or submit money-related forms: return human{reason} instead.
Any captcha ("I'm not a robot", pick the squares, type the letters, drag a slider): use captcha. Only when it says it is not solved twice, return human{reason}.
Prefer the shortest path. When the tree shows the goal is met, return done with achieved=true.
If the same step fails twice, try another element or return done with achieved=false.${maxBatch > 1 ? `\n${BATCH}` : ""}`;

/** Run the agent until it says done, a person says stop, or the budget runs out. */
export async function exploreWithAgent(o: AgentOptions): Promise<AgentResult> {
  const steps: StepRecord[] = [...(o.prior ?? [])];
  const max = steps.length + (o.maxSteps ?? 25);
  const maxBatch = Math.max(1, o.maxBatch ?? 6);
  const system = systemFor(maxBatch);
  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  let nudged = false;
  /** The page the last journaled thought was on: one note per page keeps compiled steps page-sized. */
  let notedOn: string | null = null;
  /** The acts the last batch planned and did not run, and why: the next prompt shows them once. */
  let notRun: string | null = null;
  const inputs = [
    ...Object.entries(o.inputs ?? {}).map(([k, v]) => `${k}: ${v}`),
    ...(o.secrets?.length ? [`SECRETS (use place): ${o.secrets.join(", ")}`] : []),
  ].join("\n");
  const session = o.session ?? `cli-${Date.now().toString(36)}`;
  /** When the current step began: observe, model, act; the next act in a batch starts when one lands. */
  let t0 = Date.now();
  /** Every step goes out through here once: the caller's hook and the ledger row. */
  const land = (rec: StepRecord): void => {
    rec.ms = Date.now() - t0;
    t0 = Date.now();
    steps.push(rec);
    o.onStep?.(rec);
    void o.ledger
      ?.record({
        at: new Date().toISOString(),
        session,
        site: o.site ?? "",
        n: rec.n,
        model: o.llm.id,
        inputTokens: rec.usage.inputTokens,
        outputTokens: rec.usage.outputTokens,
        cmd: rec.step?.action.cmd ?? "invalid",
        ok: rec.error === null,
        error: rec.error,
        missed: rec.missed,
        ms: rec.ms,
        host: hostOf(rec.url),
      })
      .catch(() => undefined);
  };
  for (let n = steps.length + 1; n <= max; n = steps.length + 1) {
    await o.explorer.resumed();
    if (o.stopped?.()) return { achieved: false, summary: "stopped by a person", steps, usage };
    t0 = Date.now();
    const url = (await o.explorer.exec({ cmd: "url" })) as { url: string };
    const aria = (await o.explorer.exec({ cmd: "aria", limit: 60_000, extras: true })) as {
      aria: string;
      extras?: Extra[];
    };
    // The whole outline every step: a model with no memory between calls (claude-code) guessed refs from a delta.
    const page = digest(aria.aria, { maxRefs: o.maxRefs ?? 80, extras: aria.extras ?? [] });
    const shown = page.text;
    // About the last two batches: a batch's acts are one turn to the model.
    const history = steps
      .slice(-Math.max(6, 2 * maxBatch))
      .map(
        (s) =>
          `${s.n}. ${describe(s)} → ${s.error ? `FAILED: ${s.error}` : outcome(s)}${s.missed ? ` (the plan stopped here: ${MISSED[s.missed]})` : ""}`,
      )
      .join("\n");
    const skipped = notRun ? `\nNOT RUN: ${notRun}` : "";
    notRun = null;
    const prompt = `GOAL: ${o.goal}\n${inputs ? `INPUTS:\n${inputs}\n` : ""}\nSTEP ${n} of ${max}\nURL: ${url.url}\nRECENT STEPS:\n${history || "(none)"}${skipped}\n\nPAGE:\n${shown}`;
    let plan: Plan;
    let stepUsage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
    try {
      const reply = await withTrace({ session, step: n }, () =>
        completeJson(o.llm, planSchema, {
          purpose: "agent-step",
          system,
          prompt,
          maxTokens: 400 + 200 * maxBatch,
        }),
      );
      usage.inputTokens += reply.usage.inputTokens;
      usage.outputTokens += reply.usage.outputTokens;
      stepUsage = reply.usage;
      plan = reply.value;
    } catch (err) {
      if (!(err instanceof LlmOutputInvalid)) throw err;
      usage.inputTokens += err.usage.inputTokens;
      usage.outputTokens += err.usage.outputTokens;
      stepUsage = err.usage;
      // A malformed reply is a failed step the model sees next turn, not the end of the run.
      land({
        n,
        step: null,
        result: null,
        error: `your reply was not a valid action (${err.issues})`,
        url: url.url,
        usage: stepUsage,
        ms: 0,
        batch: n,
        missed: null,
      });
      continue;
    }
    const step: Step = { thought: plan.thought, action: plan.actions[0] as Step["action"] };
    const rec: StepRecord = {
      n,
      step,
      result: null,
      error: null,
      url: url.url,
      usage: stepUsage,
      ms: 0,
      batch: n,
      missed: null,
    };
    // Giving up with budget left and nothing tried that failed: once, push back.
    if (step.action.cmd === "done" && !step.action.achieved && !nudged && n < max) {
      const tried = steps.some((s) => s.error);
      if (!tried) {
        nudged = true;
        rec.error = `you gave up at step ${n} of ${max} without any failed act; look at the controls again (names carry content) and try the most promising path before deciding`;
        land(rec);
        continue;
      }
    }
    if (step.action.cmd === "human" && o.onHuman) {
      await o.explorer.exec({ cmd: "note", text: `needs a person: ${step.action.reason}` });
      land(rec);
      if (await o.onHuman(step.action.reason)) continue;
      return { achieved: false, summary: step.action.reason, steps, usage };
    }
    if (step.action.cmd === "done" || step.action.cmd === "human") {
      await o.explorer.exec({ cmd: "note", text: step.thought });
      land(rec);
      const achieved = step.action.cmd === "done" && step.action.achieved;
      const summary = step.action.cmd === "done" ? step.action.summary : step.action.reason;
      return { achieved, summary, steps, usage };
    }
    if (notedOn !== url.url) {
      await o.explorer.exec({ cmd: "note", text: step.thought });
      notedOn = url.url;
    }
    // The schema keeps done and human alone, so every act here is one the browser runs.
    const acts = plan.actions as Act[];
    const runs = Math.min(acts.length, maxBatch, max - n + 1);
    /** The page before the act that runs next; read only when a second act may follow. */
    let was = runs > 1 && !endsBatch(acts[0] as Act, page) ? await stateOf(o.explorer) : null;
    for (let i = 0; i < runs; i++) {
      const act = acts[i] as Act;
      const r: StepRecord =
        i === 0
          ? rec
          : {
              ...rec,
              n: steps.length + 1,
              step: { thought: plan.thought, action: act },
              usage: { inputTokens: 0, outputTokens: 0 },
            };
      try {
        r.result = clip(await o.explorer.exec(toCommand(act, page)));
      } catch (err) {
        r.error = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "failed";
        // The person said no to spending (or could not be asked): that ends the goal, not the model's turn.
        if (err instanceof PaymentGate) {
          land(r);
          return { achieved: false, summary: err.message, steps, usage };
        }
      }
      const next = acts[i + 1];
      if (!next) {
        land(r);
        break;
      }
      // Why the batch ends after this act, if it does. The code decides, not the model.
      let why: string | null = null;
      if (r.error) r.missed = "error";
      else if (endsBatch(act, page))
        why = `a ${act.cmd} like step ${r.n} is always the last action run`;
      else if (i + 1 >= runs) why = `more than ${maxBatch} actions, or past the step budget`;
      else if (o.explorer.paused() || o.stopped?.()) why = "a person paused the run";
      else {
        const now = await stateOf(o.explorer);
        r.missed =
          moved(was as PageState, now) ?? ((await usable(o.explorer, next, page)) ? null : "gone");
        was = now;
      }
      land(r);
      if (r.missed) why = `the plan stopped after step ${r.n}: ${MISSED[r.missed]}`;
      if (why) {
        notRun = `${acts
          .slice(i + 1)
          .map(describeAct)
          .join("; ")} (${why})`;
        break;
      }
    }
  }
  return { achieved: false, summary: `no verdict after ${max} steps`, steps, usage };
}

/** Each miss in words, for the model. */
const MISSED: Record<Miss, string> = {
  gone: "the next target was gone, hidden or disabled",
  navigated: "the URL changed",
  dialog: "a dialog opened",
  invalid: "an alert or an invalid field showed",
  error: "the act failed",
};

/** Acts that may come before others in a batch: they stay on one screen. */
const MID_BATCH = new Set<Act["cmd"]>(["fill", "place", "select", "upload", "read"]);
/** A click on these roles stays on the screen too: it sets a value or shows a part. */
const TOGGLES = new Set(["checkbox", "radio", "option", "switch", "tab", "combobox"]);

/** Whether an act is a batch's last: a button or link click, press, open, key, captcha, os, keep. */
function endsBatch(a: Act, page: Digest): boolean {
  if (MID_BATCH.has(a.cmd)) return false;
  if (a.cmd !== "click") return true;
  const role = page.refs.find((r) => r.n === a.ref)?.role;
  return !role || !TOGGLES.has(role);
}

/** What a batch watches between acts: where the page is and what it shows. */
interface PageState {
  url: string;
  dialogs: number;
  alerts: number;
  invalid: number;
}

/** Shown dialogs, alerts with text, and fields marked invalid, in the page's main frame. */
const PAGE_STATE = `(() => {
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const count = (sel, text) =>
    [...document.querySelectorAll(sel)].filter((el) => shown(el) && (!text || el.textContent.trim())).length;
  return {
    dialogs: count('dialog[open], [role="dialog"], [role="alertdialog"]'),
    alerts: count('[role="alert"]', true),
    invalid: count('[aria-invalid="true"]'),
  };
})()`;

/** Whether the element can take an act: it has a box, is not hidden, and is not disabled. */
const USABLE = `(el) => {
  const r = el.getBoundingClientRect();
  const shown = r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  return shown && !el.matches(":disabled") && el.getAttribute("aria-disabled") !== "true";
}`;

async function stateOf(ex: Explorer): Promise<PageState> {
  const { url } = (await ex.exec({ cmd: "url" })) as { url: string };
  const { result } = (await ex.exec({ cmd: "eval", js: PAGE_STATE })) as {
    result: Omit<PageState, "url">;
  };
  return { url, ...result };
}

/** The miss an act caused, from the page before and after it; a listbox popup is no dialog. */
function moved(was: PageState, now: PageState): Miss | null {
  if (now.url !== was.url) return "navigated";
  if (now.dialogs > was.dialogs) return "dialog";
  if (now.alerts > was.alerts || now.invalid > was.invalid) return "invalid";
  return null;
}

/**
 * The next act's precondition, without a model call: its ref is found by
 * its digest hints (role and exact name, so a fill still meets its field)
 * and is shown and enabled. An act with no ref has nothing to check.
 */
async function usable(ex: Explorer, a: Act, page: Digest): Promise<boolean> {
  if (!("ref" in a)) return true;
  const ref = page.refs.find((r) => r.n === a.ref);
  if (!ref) return false;
  const hints = hintsFor(ref);
  const { count } = (await ex.exec({ cmd: "count", hints })) as { count: number };
  if (count <= (hints.nth ?? 0)) return false;
  const { result } = (await ex.exec({ cmd: "eval", hints, js: USABLE })) as { result: unknown };
  return result === true;
}

type Act = Exclude<Step["action"], { cmd: "done" } | { cmd: "human" }>;

/** The model's step as an explore command; a ref must be one the digest listed. */
function toCommand(a: Act, page: Digest): ExploreCommand {
  if (a.cmd === "open") return { cmd: "open", url: a.url };
  if (a.cmd === "key") return { cmd: "key", key: a.key };
  if (a.cmd === "captcha") return { cmd: "captcha" };
  if (a.cmd === "os") return { cmd: "os", act: a.act };
  if (a.cmd === "records")
    return {
      cmd: "records",
      as: a.as,
      goal: a.goal,
      fields: a.fields,
      ...(a.max ? { max: a.max } : {}),
    };
  const ref = page.refs.find((r) => r.n === a.ref);
  if (!ref) throw new Error(`ref ${a.ref} is not on the page; refs go 1..${page.refs.length}`);
  const hints = hintsFor(ref);
  switch (a.cmd) {
    case "click":
      return { cmd: "click", hints, goal: a.goal };
    case "fill":
      return { cmd: "fill", hints, value: a.value, goal: a.goal };
    case "place":
      return { cmd: "place", hints, secret: a.secret, goal: a.goal };
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
    rows?: number;
    first?: string;
    tree?: string;
    apps?: string[];
    code?: number;
    stdout?: string;
    stderr?: string;
  } | null;
  if (s.step?.action.cmd === "read" && r?.text !== undefined)
    return `ok: ${JSON.stringify(r.text.slice(0, 300))}`;
  if (s.step?.action.cmd === "records" && r?.rows !== undefined)
    return `ok, ${r.rows} rows; the first: ${r.first?.slice(0, 1_500) ?? ""}`;
  if (s.step?.action.cmd === "os" && r) {
    if (r.tree !== undefined) return `ok, the front app shows:\n${r.tree.slice(0, 6_000)}`;
    if (r.apps) return `ok: ${r.apps.join(", ")}`;
    if (r.code !== undefined)
      return `exit ${r.code}${r.stdout ? `\n${r.stdout.slice(0, 1_500)}` : ""}${r.stderr ? `\nstderr: ${r.stderr.slice(0, 500)}` : ""}`;
  }
  return "ok";
}

function describe(s: StepRecord): string {
  return s.step ? describeAct(s.step.action) : "(no action)";
}

function describeAct(a: Step["action"]): string {
  const at = "ref" in a ? ` [${a.ref}]` : "";
  const what =
    a.cmd === "os"
      ? ` ${a.act.op}${"name" in a.act ? ` "${a.act.name}"` : "app" in a.act && a.act.app ? ` ${a.act.app}` : "combo" in a.act ? ` ${a.act.combo}` : "command" in a.act ? ` ${a.act.command.slice(0, 60)}` : ""}`
      : a.cmd === "open"
        ? ` ${a.url}`
        : a.cmd === "fill" || a.cmd === "select"
          ? ` "${a.value}"`
          : a.cmd === "place"
            ? ` secret ${a.secret}`
            : a.cmd === "read" || a.cmd === "records"
              ? ` as ${a.as}`
              : a.cmd === "keep"
                ? ` as ${a.env}`
                : "";
  return `${a.cmd}${at}${what}`;
}
