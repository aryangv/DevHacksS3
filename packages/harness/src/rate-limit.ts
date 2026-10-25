import type { Clock } from "@campus/contracts";

// Sliding-window limiter for model calls per user / per conversation (spec 4.4, 12).
// In-process; swap for Redis (REDIS_URL) when running several workers.

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: Clock,
  ) {}

  /** Records a hit and returns true if under the limit; returns false (no hit recorded) otherwise. */
  tryTake(key: string): boolean {
    if (this.limit <= 0) return true;
    const now = this.clock.now().getTime();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
