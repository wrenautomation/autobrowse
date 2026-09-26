/**
 * A browser a run just used, kept open for the next run on the same site.
 * A person's check-in (a gate, a NeedsHuman) sits between two runs: without
 * this the browser closes at every one, and the page (a half-filled
 * checkout, a list to pick from) is gone when the answer comes back. With
 * it, the next run takes the same browser on the same page.
 *
 * Bounded both ways: at most `max` parked (the oldest closes first), and
 * each closes after `idleMs` untaken. The timers never hold a process open.
 */
import type { Session } from "./session.js";

export interface ParkOptions {
  /** A parked browser untaken this long closes. */
  idleMs: number;
  /** At most this many open at once (~300 MB each). */
  max: number;
}

interface Parked {
  session: Session;
  timer: ReturnType<typeof setTimeout>;
}

export class SessionPark {
  private readonly parked = new Map<string, Parked>();

  constructor(private readonly o: ParkOptions) {}

  get size(): number {
    return this.parked.size;
  }

  /** The browser parked for `key`, now the caller's; null when none (or it died meanwhile). */
  async take(key: string): Promise<Session | null> {
    const p = this.parked.get(key);
    if (!p) return null;
    this.parked.delete(key);
    clearTimeout(p.timer);
    const alive = await Promise.race([
      p.session.page.evaluate("1").then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((r) => setTimeout(() => r(false), 3_000).unref?.()),
    ]);
    if (alive) return p.session;
    await p.session.close().catch(() => undefined);
    return null;
  }

  /** Keep `session` for the next run on `key`. */
  async put(key: string, session: Session): Promise<void> {
    await this.drop(key);
    while (this.parked.size >= this.o.max) {
      const oldest = this.parked.keys().next().value;
      if (oldest === undefined) break;
      await this.drop(oldest);
    }
    const timer = setTimeout(() => void this.drop(key), this.o.idleMs);
    timer.unref?.();
    this.parked.set(key, { session, timer });
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.parked.keys()].map((k) => this.drop(k)));
  }

  private async drop(key: string): Promise<void> {
    const p = this.parked.get(key);
    if (!p) return;
    this.parked.delete(key);
    clearTimeout(p.timer);
    await p.session.close().catch(() => undefined);
  }
}
