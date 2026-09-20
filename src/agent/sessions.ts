/**
 * Agent sessions behind the UI: start one on a site with a goal, watch
 * its steps and screenshots, pause to act by hand, resume, stop, save
 * the journal as a recording. One explore server per session on its own
 * loopback port; the registry is in memory, like the event bus: the
 * saved recording is what lasts.
 */
import { randomBytes } from "node:crypto";
import type { Explorer } from "../explore/server.js";
import type { Llm } from "../llm/types.js";
import { type AgentResult, exploreWithAgent, type StepRecord } from "./explorer.js";

export type SessionStatus =
  | "starting"
  | "running"
  | "paused"
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
  close(id: string): Promise<SessionView>;
}

export interface SessionsOptions {
  llm: Llm;
  /** Opens an explore server for the site on the port; the login hook rides inside. */
  open(site: string, port: number): Promise<Explorer>;
  /** First loopback port; each live session takes the next free one. */
  basePort?: number;
  maxSteps?: number;
  now?: () => Date;
}

interface Live {
  view: SessionView;
  explorer: Explorer | null;
  stopFlag: boolean;
  finished: Promise<void>;
}

export function agentSessions(o: SessionsOptions): AgentSessions {
  const sessions = new Map<string, Live>();
  const now = o.now ?? (() => new Date());
  const base = o.basePort ?? 9100;

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

  return {
    async start(req) {
      const id = randomBytes(6).toString("hex");
      const view: SessionView = {
        id,
        site: req.site,
        goal: req.goal,
        inputs: req.inputs ?? {},
        status: "starting",
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
      live.finished = (async () => {
        try {
          const ex = await o.open(req.site, view.port);
          live.explorer = ex;
          void ex.done.then(() => {
            if (view.status !== "closed" && view.status !== "done") view.status = "closed";
          });
          if (req.url) await ex.exec({ cmd: "open", url: req.url });
          view.status = "running";
          const result: AgentResult = await exploreWithAgent({
            explorer: ex,
            llm: o.llm,
            goal: req.goal,
            inputs: view.inputs,
            maxSteps: req.maxSteps ?? o.maxSteps ?? 25,
            stopped: () => live.stopFlag,
            onStep: (r) => {
              const step: StepView = { ...r, screenshot: null };
              view.steps.push(step);
              // Off the loop: the picture arrives when it arrives.
              void ex
                .exec({ cmd: "screenshot" })
                .then((s) => {
                  step.screenshot = (s as { file: string }).file;
                })
                .catch(() => undefined);
            },
          });
          view.usage = result.usage;
          view.achieved = result.achieved;
          view.summary = result.summary;
          view.status = live.stopFlag ? "stopped" : "done";
        } catch (err) {
          view.error = err instanceof Error ? err.message : String(err);
          view.status = "failed";
        }
      })();
      return view;
    },
    list: () => [...sessions.values()].map((s) => s.view),
    get: (id) => sessions.get(id)?.view ?? null,
    async pause(id) {
      const live = must(id);
      await open(live).exec({ cmd: "pause" });
      if (live.view.status === "running") live.view.status = "paused";
      return live.view;
    },
    async resume(id) {
      const live = must(id);
      await open(live).exec({ cmd: "resume" });
      if (live.view.status === "paused") live.view.status = "running";
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
      return live.view;
    },
    async close(id) {
      const live = must(id);
      live.stopFlag = true;
      if (live.explorer) {
        if (live.explorer.paused()) await live.explorer.exec({ cmd: "resume" });
        await live.finished;
        await live.explorer.exec({ cmd: "close" }).catch(() => undefined);
      }
      live.view.status = "closed";
      return live.view;
    },
  };
}
