/**
 * Agent sessions behind the UI: start one on a site with a goal, watch
 * its steps and screenshots, pause to act by hand, resume, stop, save
 * the journal as a recording. One explore server per session on its own
 * loopback port; the registry is in memory, like the event bus: the
 * saved recording is what lasts.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunEvent } from "../engine/events.js";
import type { ExploreCommand, Explorer } from "../explore/server.js";
import type { Llm } from "../llm/types.js";
import { type AgentResult, exploreWithAgent, type StepRecord } from "./explorer.js";
import type { StepLedger } from "./ledger.js";

export type SessionStatus =
  | "starting"
  | "running"
  | "paused"
  /** The agent asked for a person; the browser is theirs until they resume. */
  | "needs-human"
  | "done"
  | "stopped"
  | "failed"
  | "closed";

export interface StepView extends StepRecord {
  /** Screenshot after the step, a file under the recordings dir. */
  screenshot: string | null;
}

export interface SessionView {
  id: string;
  site: string;
  goal: string;
  inputs: Record<string, string>;
  status: SessionStatus;
  /** Why the agent asked for a person, while `needs-human`. */
  prompt: string | null;
  steps: StepView[];
  achieved: boolean | null;
  summary: string | null;
  error: string | null;
  /** Directory of the saved recording, once saved. */
  recording: string | null;
  recordingName: string | null;
  usage: { inputTokens: number; outputTokens: number };
  startedAt: string;
  port: number;
}

/** A list row: the session without its steps. */
export interface SessionSummary extends Omit<SessionView, "steps"> {
  stepCount: number;
}

export const summarizeSession = ({ steps, ...rest }: SessionView): SessionSummary => ({
  ...rest,
  stepCount: steps.length,
});

export interface StartRequest {
  site: string;
  goal: string;
  inputs?: Record<string, string>;
  maxSteps?: number;
  url?: string | null;
}

export interface AgentSessions {
  start(req: StartRequest): Promise<SessionView>;
  list(): SessionView[];
  get(id: string): SessionView | null;
  pause(id: string): Promise<SessionView>;
  resume(id: string): Promise<SessionView>;
  stop(id: string): Promise<SessionView>;
  /** Journal → recording under the recordings dir; the session stays open for more. */
  save(id: string, name: string): Promise<SessionView>;
  /**
   * One explore command from a person (open, click, fill, note, aria …)
   * while the agent is paused or finished; journaled like the agent's own.
   */
  exec(id: string, command: ExploreCommand): Promise<unknown>;
  close(id: string): Promise<SessionView>;
  /** Resolves once every pending disk write has landed (shutdown, tests). */
  flush(): Promise<void>;
}

export interface SessionsOptions {
  llm: Llm;
  /**
   * Opens an explore server for the site on the port; the login hook rides
   * inside. `session` names its journal, so a pick-up keeps the acts before.
   */
  open(site: string, port: number, session?: string): Promise<Explorer>;
  /** First loopback port; each live session takes the next free one. */
  basePort?: number;
  maxSteps?: number;
  now?: () => Date;
  /** A line to the person when the agent needs them or finishes (a phone, email); optional. */
  notify?: (text: string) => Promise<void>;
  /** Every step as a hash-chained row; optional. */
  ledger?: StepLedger;
  /**
   * Sessions as rows of the Runs registry (workflow `agent`, key = session id): started, a
   * `step` per agent step, finished. A session that dies with the worker is finished as failed
   * on the next start, so the registry never shows one running that is not.
   */
  emit?: (event: RunEvent) => Promise<void>;
  /**
   * Where session views are written (one JSON per session) so the list,
   * and the evaluator's evidence, survive a worker restart. Sessions that
   * were live when the process died come back as closed.
   */
  dir?: string;
}

interface Live {
  view: SessionView;
  explorer: Explorer | null;
  stopFlag: boolean;
  finished: Promise<void>;
}

const LIVE_STATES = new Set<SessionStatus>(["starting", "running", "paused", "needs-human"]);

/** The registry's workflow name for agent sessions. */
export const AGENT = "agent";

export function agentSessions(o: SessionsOptions): AgentSessions {
  const sessions = new Map<string, Live>();
  const now = o.now ?? (() => new Date());
  const emit = (event: RunEvent): Promise<void> =>
    o.emit ? o.emit(event).catch(() => undefined) : Promise.resolve();
  const base = o.basePort ?? 9100;
  // The disk copy is a convenience; the live view is the truth. Writes go
  // off the loop, one at a time per session, and a burst of steps lands as
  // the newest view once rather than a queue of stale ones.
  const writing = new Map<string, { again: boolean; done: Promise<void> }>();
  const persist = (view: SessionView) => {
    if (!o.dir) return;
    const dir = o.dir;
    const w = writing.get(view.id);
    if (w) {
      w.again = true;
      return;
    }
    const entry = { again: false, done: Promise.resolve() };
    writing.set(view.id, entry);
    entry.done = (async () => {
      do {
        entry.again = false;
        try {
          await mkdir(dir, { recursive: true });
          // Written whole then renamed: a reader never sees half a view.
          const path = join(dir, `${view.id}.json`);
          await writeFile(`${path}.tmp`, JSON.stringify(view, null, 2));
          await rename(`${path}.tmp`, path);
        } catch {
          // see above
        }
      } while (entry.again);
      writing.delete(view.id);
    })();
  };
  if (o.dir && existsSync(o.dir)) {
    for (const f of readdirSync(o.dir).filter((f) => f.endsWith(".json"))) {
      try {
        const view = JSON.parse(readFileSync(join(o.dir, f), "utf8")) as SessionView;
        if (LIVE_STATES.has(view.status)) {
          view.status = "closed";
          view.error = view.error ?? "the worker restarted while this session was live";
          persist(view);
          void emit({
            type: "finished",
            run: { workflow: AGENT, key: view.id },
            at: now().toISOString(),
            status: "failed",
            summary: view.error,
          });
        }
        sessions.set(view.id, {
          view,
          explorer: null,
          stopFlag: true,
          finished: Promise.resolve(),
        });
      } catch {
        // not a session file
      }
    }
  }

  const freePort = () => {
    const used = new Set(
      [...sessions.values()].filter((s) => s.view.status !== "closed").map((s) => s.view.port),
    );
    let p = base;
    while (used.has(p)) p++;
    return p;
  };
  const must = (id: string): Live => {
    const live = sessions.get(id);
    if (!live) throw new Error(`no agent session ${id}`);
    return live;
  };
  const open = (live: Live): Explorer => {
    if (!live.explorer || live.view.status === "closed")
      throw new Error(`agent session ${live.view.id} is closed`);
    return live.explorer;
  };

  /**
   * The agent on the session's explorer until done. `view.steps` already
   * holding steps is a pick-up: the agent sees them as its own and goes on.
   */
  const drive = (live: Live, req: StartRequest): void => {
    const view = live.view;
    const ref = { workflow: AGENT, key: view.id };
    const before = { ...view.usage };
    void emit({ type: "started", run: ref, at: now().toISOString() });
    live.finished = (async () => {
      try {
        const ex = await o.open(req.site, view.port, view.id);
        live.explorer = ex;
        void ex.done.then(() => {
          if (view.status !== "closed" && view.status !== "done") view.status = "closed";
          // The browser is gone; nothing keeps its pages and journal alive.
          live.explorer = null;
        });
        if (req.url) await ex.exec({ cmd: "open", url: req.url });
        view.status = "running";
        const result: AgentResult = await exploreWithAgent({
          explorer: ex,
          llm: o.llm,
          goal: req.goal,
          inputs: view.inputs,
          maxSteps: req.maxSteps ?? o.maxSteps ?? 25,
          session: view.id,
          prior: [...view.steps],
          site: req.site,
          ...(o.ledger ? { ledger: o.ledger } : {}),
          stopped: () => live.stopFlag,
          // The model's `human` is a pause with a prompt, not the end: the
          // person does the thing in the window and resumes.
          onHuman: async (reason) => {
            view.status = "needs-human";
            view.prompt = reason;
            await ex.exec({ cmd: "pause" });
            persist(view);
            await o
              .notify?.(`agent on ${req.site} needs you: ${reason} (session ${view.id})`)
              .catch(() => undefined);
            await ex.resumed();
            view.prompt = null;
            if (!live.stopFlag) view.status = "running";
            return !live.stopFlag;
          },
          onStep: (r) => {
            const step: StepView = { ...r, screenshot: null };
            view.steps.push(step);
            persist(view);
            void emit({
              type: "step",
              run: ref,
              at: now().toISOString(),
              step: `${r.n}. ${r.step?.action.cmd ?? "invalid"}`,
              result: {
                status: r.error ? "failed" : "done",
                detail: r.error ?? r.step?.thought ?? "",
                at: now().toISOString(),
              },
            });
            // Off the loop: the picture arrives when it arrives.
            void ex
              .exec({ cmd: "screenshot" })
              .then((s) => {
                step.screenshot = (s as { file: string }).file;
              })
              .catch(() => undefined);
          },
        });
        view.usage = {
          inputTokens: before.inputTokens + result.usage.inputTokens,
          outputTokens: before.outputTokens + result.usage.outputTokens,
        };
        view.achieved = result.achieved;
        view.summary = result.summary;
        view.status = live.stopFlag ? "stopped" : "done";
        if (!live.stopFlag)
          await o
            .notify?.(
              `agent on ${req.site} ${result.achieved ? "achieved" : "did not achieve"}: ${req.goal} — ${result.summary}`,
            )
            .catch(() => undefined);
      } catch (err) {
        view.error = err instanceof Error ? err.message : String(err);
        view.status = "failed";
      }
      persist(view);
      void emit({
        type: "finished",
        run: ref,
        at: now().toISOString(),
        status:
          view.status === "failed" ? "failed" : view.status === "stopped" ? "rejected" : "done",
        summary:
          view.error ?? `${view.achieved ? "achieved" : "not achieved"}: ${view.summary ?? ""}`,
      });
    })();
  };

  return {
    async flush() {
      while (writing.size > 0) await Promise.all([...writing.values()].map((w) => w.done));
    },
    async start(req) {
      const id = randomBytes(6).toString("hex");
      const view: SessionView = {
        id,
        site: req.site,
        goal: req.goal,
        inputs: req.inputs ?? {},
        status: "starting",
        prompt: null,
        steps: [],
        achieved: null,
        summary: null,
        error: null,
        recording: null,
        recordingName: null,
        usage: { inputTokens: 0, outputTokens: 0 },
        startedAt: now().toISOString(),
        port: freePort(),
      };
      const live: Live = { view, explorer: null, stopFlag: false, finished: Promise.resolve() };
      sessions.set(id, live);
      persist(view);
      drive(live, req);
      return view;
    },
    list: () =>
      [...sessions.values()]
        .map((s) => s.view)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    get: (id) => sessions.get(id)?.view ?? null,
    async pause(id) {
      const live = must(id);
      await open(live).exec({ cmd: "pause" });
      if (live.view.status === "running") live.view.status = "paused";
      return live.view;
    },
    async resume(id) {
      const live = must(id);
      // Its browser died (a crash, a restart): a new one on the last page,
      // and the agent goes on from its last step instead of step 1.
      if (!live.explorer && live.view.status !== "done" && live.view.status !== "stopped") {
        const view = live.view;
        Object.assign(view, { status: "starting", error: null, prompt: null, port: freePort() });
        live.stopFlag = false;
        persist(view);
        drive(live, { site: view.site, goal: view.goal, url: view.steps.at(-1)?.url ?? null });
        return view;
      }
      await open(live).exec({ cmd: "resume" });
      if (live.view.status === "paused" || live.view.status === "needs-human")
        live.view.status = "running";
      return live.view;
    },
    async stop(id) {
      const live = must(id);
      live.stopFlag = true;
      if (live.explorer?.paused()) await live.explorer.exec({ cmd: "resume" });
      await live.finished;
      return live.view;
    },
    async save(id, name) {
      const live = must(id);
      const saved = (await open(live).exec({ cmd: "save", name })) as { dir: string };
      live.view.recording = saved.dir;
      live.view.recordingName = name;
      persist(live.view);
      return live.view;
    },
    async exec(id, command) {
      const live = must(id);
      if (command.cmd === "close" || command.cmd === "save")
        throw new Error(`use the ${command.cmd} action, not exec`);
      if (live.view.status === "running" || live.view.status === "starting")
        throw new Error("pause the agent first; two drivers on one page collide");
      return open(live).exec(command);
    },
    async close(id) {
      const live = must(id);
      live.stopFlag = true;
      if (live.explorer) {
        if (live.explorer.paused()) await live.explorer.exec({ cmd: "resume" });
        await live.finished;
        await live.explorer.exec({ cmd: "close" }).catch(() => undefined);
        live.explorer = null;
      }
      live.view.status = "closed";
      persist(live.view);
      return live.view;
    },
  };
}
