/**
 * What the model picked for earlier goals, shown to it next time so the
 * same ask phrased differently lands on the same ability. A small JSON
 * file; the newest pairs win the space.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PickPair {
  goal: string;
  ability: string;
  at: string;
}

export interface PickMemory {
  recall(): Promise<PickPair[]>;
  remember(goal: string, ability: string): Promise<void>;
}

const KEEP = 200;

export function memoryPicks(initial: PickPair[] = []): PickMemory & { pairs: PickPair[] } {
  const pairs = [...initial];
  return {
    pairs,
    recall: async () => [...pairs],
    remember: async (goal, ability) => {
      const i = pairs.findIndex((p) => p.goal === goal);
      if (i >= 0) pairs.splice(i, 1);
      pairs.push({ goal, ability, at: new Date().toISOString() });
      if (pairs.length > KEEP) pairs.splice(0, pairs.length - KEEP);
    },
  };
}

export function filePicks(file: string): PickMemory {
  const read = (): PickPair[] => {
    try {
      const got = JSON.parse(readFileSync(file, "utf8")) as unknown;
      return Array.isArray(got) ? (got as PickPair[]) : [];
    } catch {
      return [];
    }
  };
  return {
    recall: async () => read(),
    remember: async (goal, ability) => {
      const mem = memoryPicks(read());
      await mem.remember(goal, ability);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(mem.pairs, null, 2)}\n`);
    },
  };
}
