/** In-memory `Effects`: runs effects straight away, keeps state in a map. Tests and one-process runs. */
import type { Effects } from "./effects.js";

export interface MemoryHost {
  fx: Effects;
  state: Map<string, unknown>;
  /** Names of every journaled effect, in order. */
  runs: string[];
}

export function memoryEffects(
  opts: { now?: () => Date; sleep?: (ms: number) => Promise<void> } = {},
): MemoryHost {
  const state = new Map<string, unknown>();
  const runs: string[] = [];
  const now = opts.now ?? (() => new Date());
  const fx: Effects = {
    async run(name, fn) {
      runs.push(name);
      return fn();
    },
    async get(key) {
      return (state.get(key) as never) ?? null;
    },
    set(key, value) {
      state.set(key, structuredClone(value));
    },
    clear(key) {
      state.delete(key);
    },
    sleep: opts.sleep ?? (async () => undefined),
    async now() {
      return now();
    },
  };
  return { fx, state, runs };
}
