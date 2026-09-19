/**
 * Backboard as the memory store: one assistant per deployment (found by
 * name, created once), memories under it. Search is theirs; we only add
 * and query. The key rides in a header only.
 */
import type { HttpClient } from "../clients/http.js";
import type { Memory, MemoryItem } from "./types.js";

const BASE = "https://app.backboard.io/api";

interface Assistant {
  assistant_id?: string;
  id?: string;
  name: string;
}
interface SearchResponse {
  memories: Array<{
    id: string;
    content: string;
    score?: number | null;
    created_at?: string | null;
  }>;
}
interface AddResponse {
  id?: string;
  memory_id?: string;
  operation_id?: string;
}

export interface BackboardOptions {
  apiKey: string;
  http: HttpClient;
  /** Assistant name; created on first use. One per deployment keeps tenants apart. */
  assistant?: string;
}

export function backboardMemory(opts: BackboardOptions): Memory {
  const name = opts.assistant ?? "autobrowse";
  const headers = { "x-api-key": opts.apiKey };
  let assistantId: Promise<string> | null = null;

  const idOf = (a: Assistant) => a.assistant_id ?? a.id ?? "";
  const ensureAssistant = () => {
    assistantId ??= (async () => {
      const list = await opts.http.json<Assistant[]>(`${BASE}/assistants`, { headers });
      if (!list.ok) throw new Error(`backboard: list assistants HTTP ${list.status}`);
      const found = (list.body ?? []).find((a) => a.name === name);
      if (found && idOf(found)) return idOf(found);
      const created = await opts.http.json<Assistant>(`${BASE}/assistants`, {
        method: "POST",
        headers,
        body: {
          name,
          system_prompt:
            "Memory for autobrowse: what worked on which site, what people said at hand-offs.",
        },
      });
      if (!created.ok || !created.body || !idOf(created.body))
        throw new Error(`backboard: create assistant HTTP ${created.status}`);
      return idOf(created.body);
    })().catch((err) => {
      assistantId = null; // next call retries
      throw err;
    });
    return assistantId;
  };

  return {
    id: `backboard/${name}`,
    async remember(content, meta = {}) {
      const id = await ensureAssistant();
      const r = await opts.http.json<AddResponse>(`${BASE}/assistants/${id}/memories`, {
        method: "POST",
        headers,
        body: { content, metadata: meta },
      });
      if (!r.ok) throw new Error(`backboard: add memory HTTP ${r.status}`);
      return r.body?.id ?? r.body?.memory_id ?? r.body?.operation_id ?? "";
    },
    async recall(query, limit = 5): Promise<MemoryItem[]> {
      const id = await ensureAssistant();
      const r = await opts.http.json<SearchResponse>(`${BASE}/assistants/${id}/memories/search`, {
        method: "POST",
        headers,
        body: { query, limit: Math.min(Math.max(limit, 1), 50) },
      });
      if (!r.ok) throw new Error(`backboard: search HTTP ${r.status}`);
      return (r.body?.memories ?? []).map((m) => ({
        id: m.id,
        content: m.content,
        ...(m.score != null ? { score: m.score } : {}),
        ...(m.created_at ? { createdAt: m.created_at } : {}),
      }));
    },
  };
}
