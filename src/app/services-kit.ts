/** Two helpers every services-* file leans on: a setting that must be set, and a client made on first use. */
import { Unrecoverable } from "../engine/effects.js";

export function required<T>(value: T | undefined, env: string): T {
  if (value === undefined) throw new Unrecoverable(`${env} is required`);
  return value;
}

/**
 * Build a client the first time a step touches it, so a worker starts
 * with whatever credentials it has and a missing one fails the step that
 * needs it (a clear `X is required` in the run), not the whole process.
 */
export function lazy<T extends object>(make: () => T): T {
  let real: T | null = null;
  return new Proxy({} as T, {
    get(_t, prop) {
      real ??= make();
      const v = Reflect.get(real, prop) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
    },
  });
}
