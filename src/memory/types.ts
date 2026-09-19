/**
 * What the system remembers between runs: which hints worked on a site
 * after a repair, what a person said at a hand-off, what a proof looked
 * like. Free text plus a small tag map, searched by meaning. Backboard in
 * prod, an in-process list in tests. Nothing here is a secret; the
 * writers guarantee that, the store never sees a token or a password.
 */
export interface MemoryItem {
  id: string;
  content: string;
  score?: number;
  createdAt?: string;
}

export interface Memory {
  readonly id: string;
  remember(content: string, meta?: Record<string, string>): Promise<string>;
  recall(query: string, limit?: number): Promise<MemoryItem[]>;
}

/** In-process store: substring match scored by overlap, enough for tests and for `MEMORY=none`. */
export function memoryStore(): Memory & {
  items: Array<MemoryItem & { meta: Record<string, string> }>;
} {
  const items: Array<MemoryItem & { meta: Record<string, string> }> = [];
  return {
    id: "memory",
    items,
    async remember(content, meta = {}) {
      const id = String(items.length + 1);
      items.push({ id, content, meta, createdAt: new Date().toISOString() });
      return id;
    },
    async recall(query, limit = 5) {
      const words = query
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 2);
      return items
        .map((m) => {
          const text = m.content.toLowerCase();
          const score = words.filter((w) => text.includes(w)).length / Math.max(words.length, 1);
          return { ...m, score };
        })
        .filter((m) => m.score > 0)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, limit);
    },
  };
}
