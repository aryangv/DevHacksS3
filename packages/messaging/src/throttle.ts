// Client-side send throttle (spec 3.1: Sendblue bursts ~10 req/s per line, then answers 429 without
// queueing). Spaces calls at least 1000/ratePerSecond ms apart, in call order.

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Throttle {
  private nextAt = 0;
  private readonly gapMs: number;

  constructor(
    ratePerSecond: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: Sleep = realSleep,
  ) {
    this.gapMs = ratePerSecond > 0 ? Math.ceil(1000 / ratePerSecond) : 0;
  }

  /** Resolves when the caller may send. Reserves the slot synchronously, so concurrent callers queue. */
  async wait(): Promise<void> {
    if (this.gapMs === 0) return;
    const now = this.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.gapMs;
    if (at > now) await this.sleep(at - now);
  }
}
