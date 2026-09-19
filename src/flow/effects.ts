/**
 * What a flow needs from its host: journaled side effects, durable gates,
 * state. Restate provides one implementation; tests another. Steps never
 * see a Restate context, so the whole flow runs in a unit test.
 */
export type GateAnswer =
  | { approved: true; note: string | null }
  | { approved: false; note: string | null };

export interface Effects {
  /** Run once and journal the result; a replay returns the journaled value. */
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Park until a human answers. `message` is what they are shown. */
  gate(name: string, message: string): Promise<GateAnswer>;
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): void;
  /** Durable pause. */
  sleep(ms: number): Promise<void>;
  now(): Promise<Date>;
}
