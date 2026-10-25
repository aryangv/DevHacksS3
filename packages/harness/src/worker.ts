import {
  type AuditLog,
  type Clock,
  HarnessError,
  type InboundQueue,
  KeyedMutex,
  type Logger,
  type TurnOutcome,
  type TurnPipeline,
} from "@campus/contracts";

// Queue worker: claims events (per-conversation FIFO, one in flight per conversation), runs the
// pipeline, retries transient failures with backoff + jitter, dead-letters poison messages (spec 4.7).

export type QueueWorkerOptions = {
  queue: InboundQueue;
  pipeline: TurnPipeline;
  audit: AuditLog;
  logger: Logger;
  clock: Clock;
  maxAttempts: number;
  pollIntervalMs: number;
  concurrency: number;
  onOutcome?: (outcome: TurnOutcome) => void;
};

export function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 1));
  return base + Math.floor(Math.random() * 250);
}

export class QueueWorker {
  private running = false;
  private inFlight = 0;
  private readonly mutex = new KeyedMutex();
  private loop: Promise<void> | null = null;

  constructor(private readonly opts: QueueWorkerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
    while (this.inFlight > 0) await new Promise((r) => setTimeout(r, 10));
  }

  /** Process until nothing is claimable and nothing is in flight. For tests and the simulator. */
  async drain(): Promise<TurnOutcome[]> {
    const outcomes: TurnOutcome[] = [];
    for (;;) {
      const event = await this.opts.queue.claimNext();
      if (!event) break;
      const o = await this.processOne(event);
      if (o) outcomes.push(o);
    }
    return outcomes;
  }

  private async run(): Promise<void> {
    while (this.running) {
      if (this.inFlight >= this.opts.concurrency) {
        await new Promise((r) => setTimeout(r, 5));
        continue;
      }
      let event;
      try {
        event = await this.opts.queue.claimNext();
      } catch (err) {
        this.opts.logger.error("queue claim failed", { err });
        await new Promise((r) => setTimeout(r, this.opts.pollIntervalMs * 4));
        continue;
      }
      if (!event) {
        await new Promise((r) => setTimeout(r, this.opts.pollIntervalMs));
        continue;
      }
      this.inFlight += 1;
      void this.processOne(event).finally(() => (this.inFlight -= 1));
    }
  }

  private async processOne(
    event: Awaited<ReturnType<InboundQueue["claimNext"]>> & object,
  ): Promise<TurnOutcome | null> {
    const { queue, pipeline, logger } = this.opts;
    try {
      // In-process serialization on top of the queue's claim rule (defense in depth).
      const outcome = await this.mutex.run(event.conversationKey, () => pipeline.processEvent(event));
      await queue.complete(event.id);
      this.opts.onOutcome?.(outcome);
      return outcome;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = !(err instanceof HarnessError) || err.retryable;
      const dead = !retryable || event.attempts >= this.opts.maxAttempts;
      logger.warn("turn processing failed", {
        turnId: event.id,
        attempts: event.attempts,
        dead,
        errorCode: err instanceof HarnessError ? err.code : "unknown",
      });
      await queue.fail(
        event.id,
        message.slice(0, 500),
        dead
          ? { deadLetter: true }
          : {
              deadLetter: false,
              retryAt: new Date(this.opts.clock.now().getTime() + backoffMs(event.attempts)),
            },
      );
      if (dead) {
        await this.opts.audit
          .record({ action: "turn.dead_lettered", turnId: event.id, detail: { attempts: event.attempts } })
          .catch(() => undefined);
      }
      return null;
    }
  }
}
