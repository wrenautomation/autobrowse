/**
 * A mutex per key, in one process. The browser layer takes one per site:
 * a persistent Chromium profile can be open once, and a Browserbase
 * persistent context likewise, while Restate happily runs two domains'
 * steps at the same time. Waiters queue in arrival order; an idle key is
 * forgotten, so the map never grows past the sites in use.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  /** Resolves once the key is ours; call the returned function to let go. */
  async acquire(key: string): Promise<() => void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    return () => {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Keys with a holder or a queue right now. */
  get busy(): number {
    return this.tails.size;
  }
}
