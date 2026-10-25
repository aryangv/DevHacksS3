// Per-key serialization (spec 4.2 step 3: one in-flight turn per conversation_id).
// In-process only; the Postgres queue adds cross-process serialization on top.

export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  /** Run `fn` after every previously scheduled task for `key` has settled. FIFO per key. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    try {
      await previous;
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  isLocked(key: string): boolean {
    return this.tails.has(key);
  }
}
