/**
 * What a step needs from its host: journaled side effects, state, a durable
 * clock. Restate provides one implementation; tests another. Steps never
 * see a Restate context, so the whole flow runs in a unit test.
 *
 * Gates are not here. A gate is state (`answers`), read by the step that
 * needs it: when the answer is missing the step throws `GateOpen`, the
 * host records the open gate and returns, and the human's answer arrives
 * as a new invocation. No invocation ever parks, so pause, reset and
 * status can always run.
 */
export interface Effects {
  /** Run once and journal the result; a replay returns the journaled value. */
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): void;
  clear(key: string): void;
  /** Durable pause. */
  sleep(ms: number): Promise<void>;
  now(): Promise<Date>;
}

/** `human` = a person has to do something; the others are guards (see guards.ts) a person approves. */
export type GateName = "purchase" | "password" | "human";

export interface GateAnswer {
  approved: boolean;
  note: string | null;
  at: string;
}

/** Thrown by a step whose gate has no answer yet. */
export class GateOpen extends Error {
  constructor(
    readonly gate: GateName,
    readonly prompt: string,
  ) {
    super(`gate ${gate} is open`);
    this.name = "GateOpen";
  }
}

/**
 * An error no retry will fix: missing configuration, a rejected
 * credential, a plan that cannot work. The host stops retrying the effect
 * and the step fails with this message. Transient errors (network, 5xx,
 * 429) are left to the host's retry policy.
 */
export class Unrecoverable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "Unrecoverable";
  }
}
