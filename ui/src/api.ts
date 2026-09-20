/**
 * Typed client for the worker's API. Types come straight from the server
 * modules (type-only imports, nothing bundled). The bearer, when the
 * worker needs one, lives in localStorage and goes in a header only.
 */

import type { SessionView, StartRequest } from "../../src/agent/sessions.js";
import type { Compiled } from "../../src/compiler/index.js";
import type { RunEvent } from "../../src/engine/events.js";
import type { RunStatusView } from "../../src/engine/object.js";
import type { RunRow } from "../../src/engine/registry.js";
import type { Recording } from "../../src/recorder/types.js";

export type { Compiled, Recording, RunEvent, RunRow, RunStatusView, SessionView, StartRequest };

export interface WorkflowInfo {
  name: string;
  description: string;
  steps: Array<{ name: string; irreversible: boolean }>;
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

export const api = {
  workflows: () => call<WorkflowInfo[]>("/api/workflows"),
  runs: () => call<RunRow[]>("/api/runs"),
  run: (workflow: string, key: string) =>
    call<RunStatusView>(`/api/runs/${workflow}/${encodeURIComponent(key)}`),
  start: (workflow: string, key: string, plan: unknown) =>
    post(`/api/runs/${workflow}/${encodeURIComponent(key)}`, { plan }),
  action: (workflow: string, key: string, action: string, body?: { note?: string }) =>
    post(`/api/runs/${workflow}/${encodeURIComponent(key)}/${action}`, body ?? {}),
  recordings: () => call<Recording[]>("/api/recordings"),
  recording: (name: string) => call<Recording>(`/api/recordings/${name}`),
  recordingFile: (name: string, file: string) => `/api/recordings/${name}/files/${file}`,
  compile: (name: string) => post(`/api/recordings/${name}/compile`) as Promise<Compiled>,
  artifact: (path: string) => `/api/artifacts?path=${encodeURIComponent(path)}`,
  agents: () => call<SessionView[]>("/api/agent"),
  agent: (id: string) => call<SessionView>(`/api/agent/${id}`),
  agentStart: (req: StartRequest) => post("/api/agent", req) as Promise<SessionView>,
  agentAction: (id: string, action: "pause" | "resume" | "stop" | "close") =>
    post(`/api/agent/${id}/${action}`, {}) as Promise<SessionView>,
  agentSave: (id: string, name: string) =>
    post(`/api/agent/${id}/save`, { name }) as Promise<SessionView>,
  agentShot: (id: string, n: number) => `/api/agent/${id}/shot/${n}`,
  agentRepair: (failure: string) => post("/api/agent/repair", { failure }) as Promise<SessionView>,
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
