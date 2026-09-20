/**
 * Typed client for the worker's API. Types come straight from the server
 * modules (type-only imports, nothing bundled). The bearer, when the
 * worker needs one, lives in localStorage and goes in a header only.
 */

import type { Proposal } from "../../src/agent/evaluator.js";
import type { SessionSummary, SessionView, StartRequest } from "../../src/agent/sessions.js";
import type { Status } from "../../src/app/status.js";
import type { Compiled } from "../../src/compiler/index.js";
import type { RunEvent } from "../../src/engine/events.js";
import type { RunStatusView } from "../../src/engine/object.js";
import type { ListQuery, RunRow } from "../../src/engine/registry.js";
import type { Recording, RecordingSummary } from "../../src/recorder/types.js";
import type { JobView } from "../../src/ui/jobs.js";

export type {
  Compiled,
  JobView,
  Proposal,
  Recording,
  RecordingSummary,
  RunEvent,
  RunRow,
  RunStatusView,
  SessionSummary,
  SessionView,
  StartRequest,
  Status,
};

export interface Proof {
  at: string;
  status: string;
  steps: Array<{ name: string; status: string; detail: string }>;
  output: Record<string, string> | null;
}

export interface WorkflowInfo {
  name: string;
  description: string;
  steps: Array<{ name: string; irreversible: boolean }>;
  /** undefined = hand-written (tested in the repo); null = compiled, never run; else its last proof run. */
  proof?: Proof | null;
  plan: {
    properties?: Record<string, { type?: string; description?: string; default?: unknown }>;
    required?: string[];
  };
}

const TOKEN_KEY = "autobrowse.token";
export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? "";
export const setToken = (t: string) =>
  t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.error ?? res.statusText);
  return body as T;
}

const post = (path: string, body?: unknown) =>
  call(path, { method: "POST", body: body === undefined ? null : JSON.stringify(body) });

const query = (q: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

/**
 * Minutes-long work (a proof, a heal) starts as a job and is awaited here:
 * each request holds up to 25s server-side, so a wait is a few requests,
 * not a poll every second. Resolves with the result, rejects with the error.
 */
async function finish<T>(job: JobView): Promise<T> {
  let j = job;
  while (j.status === "running")
    j = await call<JobView>(`/api/jobs/${j.id}${query({ wait: 25_000 })}`);
  if (j.status === "failed") throw new ApiError(500, j.error ?? "failed");
  return j.result as T;
}

export const api = {
  status: () => call<Status | null>("/api/status"),
  workflows: () => call<WorkflowInfo[]>("/api/workflows"),
  prove: (workflow: string) =>
    (post(`/api/workflows/${workflow}/prove`) as Promise<JobView>).then((j) => finish<Proof>(j)),
  /** Newest first; `before` = the last row's updatedAt for the next page. */
  runs: (q: ListQuery = {}) => call<RunRow[]>(`/api/runs${query({ ...q })}`),
  job: (id: string, wait = 0) => call<JobView>(`/api/jobs/${id}${query({ wait })}`),
  run: (workflow: string, key: string) =>
    call<RunStatusView>(`/api/runs/${workflow}/${encodeURIComponent(key)}`),
  start: (workflow: string, key: string, plan: unknown) =>
    post(`/api/runs/${workflow}/${encodeURIComponent(key)}`, { plan }),
  action: (workflow: string, key: string, action: string, body?: { note?: string }) =>
    post(`/api/runs/${workflow}/${encodeURIComponent(key)}/${action}`, body ?? {}),
  recordings: () => call<RecordingSummary[]>("/api/recordings"),
  recording: (name: string) => call<Recording>(`/api/recordings/${name}`),
  recordingFile: (name: string, file: string) => `/api/recordings/${name}/files/${file}`,
  compile: (name: string) => post(`/api/recordings/${name}/compile`) as Promise<Compiled>,
  artifact: (path: string) => `/api/artifacts?path=${encodeURIComponent(path)}`,
  agents: () => call<SessionSummary[]>("/api/agent"),
  agent: (id: string) => call<SessionView>(`/api/agent/${id}`),
  agentStart: (req: StartRequest) => post("/api/agent", req) as Promise<SessionView>,
  agentAction: (id: string, action: "pause" | "resume" | "stop" | "close") =>
    post(`/api/agent/${id}/${action}`, {}) as Promise<SessionView>,
  agentSave: (id: string, name: string) =>
    post(`/api/agent/${id}/save`, { name }) as Promise<SessionView>,
  agentShot: (id: string, n: number) => `/api/agent/${id}/shot/${n}`,
  agentExec: (id: string, command: unknown) =>
    post(`/api/agent/${id}/exec`, command) as Promise<{ result: unknown }>,
  proposals: () =>
    call<{ proposals: Proposal[]; usage: { inputTokens: number; outputTokens: number } }>(
      "/api/agent/proposals",
    ),
  agentRepair: (failure: string) => post("/api/agent/repair", { failure }) as Promise<SessionView>,
  heal: (failure: string) =>
    (post("/api/agent/heal", { failure }) as Promise<JobView>).then((j) => finish<HealOutcome>(j)),
};

/**
 * Live events over fetch, not EventSource: EventSource cannot send a
 * header and a bearer never goes in a URL. Reconnects with `after` so
 * nothing is missed while the tab was disconnected.
 */
export function subscribe(onEvent: (event: RunEvent) => void): () => void {
  let last = 0;
  const ctl = new AbortController();
  const run = async () => {
    while (!ctl.signal.aborted) {
      try {
        const token = getToken();
        const res = await fetch(`/api/events?after=${last}`, {
          signal: ctl.signal,
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok || !res.body) throw new ApiError(res.status, "events");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let cut = buf.indexOf("\n\n");
          while (cut >= 0) {
            const frame = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            const data = frame
              .split("\n")
              .find((l) => l.startsWith("data:"))
              ?.slice(5)
              .trim();
            const id = frame
              .split("\n")
              .find((l) => l.startsWith("id:"))
              ?.slice(3)
              .trim();
            if (id) last = Number(id) || last;
            if (data) onEvent(JSON.parse(data) as RunEvent);
            cut = buf.indexOf("\n\n");
          }
        }
      } catch {
        if (ctl.signal.aborted) return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  };
  void run();
  return () => ctl.abort();
}

export interface HealOutcome {
  status: "healed" | "proof-failed" | "needs-human" | "failed" | "no-workflow";
  workflow: string | null;
  step: string | null;
  session: string | null;
  summary: string;
}
