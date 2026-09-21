/**
 * Is anyone using this worker? Work in flight holds it busy; anything that
 * just happened (an event, a request) touches it. The idle stop reads both:
 * a box that bills nothing between jobs, stopped by the worker itself once
 * nothing has needed it for a while.
 */
import type { Logger } from "pino";

export interface Idle {
  /** Something happened: the idle clock restarts. */
  touch(): void;
  /** Busy for as long as `fn` runs (a flow, a site call), then touched. */
  hold<T>(fn: () => Promise<T>): Promise<T>;
  /** Anything held right now? */
  busy(): boolean;
  /** Milliseconds since the last touch or release. */
  idleFor(): number;
}

export function idleTracker(now: () => number = Date.now): Idle {
  let last = now();
  let held = 0;
  return {
    touch: () => {
      last = now();
    },
    async hold(fn) {
      held++;
      last = now();
      try {
        return await fn();
      } finally {
        held--;
        last = now();
      }
    },
    busy: () => held > 0,
    idleFor: () => now() - last,
  };
}

/** A FlowRunner or SiteFacade whose every method runs under a hold. */
export function holding<T extends object>(idle: Idle, target: T): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const v = Reflect.get(t, prop, receiver) as unknown;
      if (typeof v !== "function") return v;
      return (...args: unknown[]) =>
        idle.hold(() => (v as (...a: unknown[]) => Promise<unknown>).apply(t, args));
    },
  });
}

export interface IdleStopOptions {
  idle: Idle;
  minutes: number;
  /** Beyond holds: an open agent session, a person at the keyboard. */
  alsoBusy?: () => boolean;
  /** Stop the machine. `false` = declined (a person started it); try again after another idle span. */
  stop: () => Promise<boolean>;
  log: Logger;
  /** Check period, ms. */
  every?: number;
  setInterval?: typeof globalThis.setInterval;
}

/** Arm the idle stop; returns a disarm. One stop at a time, never while anything is held. */
export function scheduleIdleStop(o: IdleStopOptions): () => void {
  const limit = o.minutes * 60_000;
  const every = o.every ?? 60_000;
  let stopping = false;
  const tick = async () => {
    if (stopping || o.idle.busy() || o.alsoBusy?.() || o.idle.idleFor() < limit) return;
    stopping = true;
    try {
      const done = await o.stop();
      o.log.info(
        { idleMinutes: Math.round(o.idle.idleFor() / 60_000) },
        done ? "idle: stopping the machine" : "idle, but the machine stays up",
      );
      if (!done) o.idle.touch();
    } catch (err) {
      o.log.warn({ err: err instanceof Error ? err.message : String(err) }, "idle stop failed");
      o.idle.touch();
    } finally {
      stopping = false;
    }
  };
  const timer = (o.setInterval ?? globalThis.setInterval)(() => void tick(), every);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  return () => clearInterval(timer);
}
